// uxe - run a command (default: an interactive shell) inside a running uxc
// container managed by uxcd, by joining its namespaces (the nsenter / docker
// exec model). It asks uxcd over ubus for the container's in-container init pid,
// setns()es into that process's namespaces and execs the command.
//
// With a pty (-t, or automatically for an interactive shell on a terminal) it
// allocates a pseudo-terminal so job control, line editing, window resizing and
// full-screen programs (top, vi, ...) work; the host terminal is put in raw
// mode and proxied to the pty.
//
// Namespaces the container shares with the host (e.g. the net ns of a
// host-network container, or the user ns) are detected by inode and skipped, so
// joining them never fails with EINVAL.

#include <string>
#include <vector>
#include <iostream>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>

#include <unistd.h>
#include <fcntl.h>
#include <sched.h>
#include <grp.h>
#include <termios.h>
#include <signal.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/ioctl.h>

#include "ubus.hpp"
#include "json.hpp"
#include "usage.hpp"
#include "version.hpp"

// ---- pty proxy state ---------------------------------------------------------
static int g_master = -1;
static struct termios g_saved_tio;
static bool g_tio_saved = false;
static volatile sig_atomic_t g_winch = 1;   // start true to push initial size

static void on_winch(int) { g_winch = 1; }

static void restore_tty(void) {
	if ( g_tio_saved )
		tcsetattr(STDIN_FILENO, TCSANOW, &g_saved_tio);
}

static void copy_winsize(void) {
	struct winsize ws;
	if ( ioctl(STDOUT_FILENO, TIOCGWINSZ, &ws) == 0 )
		ioctl(g_master, TIOCSWINSZ, &ws);
}

// Relay between the host terminal and the pty master until the child exits.
static void pty_relay(void) {
	char buf[4096];
	struct pollfd fds[2];
	for (;;) {
		if ( g_winch ) { g_winch = 0; copy_winsize(); }
		fds[0] = { STDIN_FILENO, POLLIN, 0 };
		fds[1] = { g_master, POLLIN, 0 };
		if ( poll(fds, 2, -1) < 0 ) {
			if ( errno == EINTR ) continue;
			break;
		}
		if ( fds[0].revents & POLLIN ) {
			ssize_t n = read(STDIN_FILENO, buf, sizeof buf);
			if ( n > 0 ) { (void)!write(g_master, buf, n); }
			else if ( n == 0 ) { /* host stdin closed */ }
		}
		if ( fds[1].revents & POLLIN ) {
			ssize_t n = read(g_master, buf, sizeof buf);
			if ( n > 0 ) { (void)!write(STDOUT_FILENO, buf, n); }
			else break;   // child gone
		}
		if ( fds[1].revents & ( POLLHUP | POLLERR )) break;
	}
}

int main(int argc, char** argv) {

	// uxe's own options precede the container; the command after it is passed
	// through verbatim (its flags are not uxe's). usage_cpp can't stop parsing at
	// a positional, so split off the container + command by hand and hand only
	// the leading options to it.
	int ci = 1;
	while ( ci < argc ) {
		std::string a = argv[ci];
		if ( a.size() > 1 && a[0] == '-' ) {
			if ( a == "-u" || a == "--uid" || a == "-w" || a == "--cwd" )
				ci += 2;   // option that takes a separate value
			else
				ci += 1;   // flag (or attached/=-form value, one token)
			continue;
		}
		break;             // the container name
	}

	std::vector<char*> oav(argv, argv + ci);
	oav.push_back(nullptr);

	usage_t usage = {
		.args = { ci, oav.data() },
		.info = {
			.name = "uxe",
			.version_title = "version ",
			.version = UXCD_VERSION,
			.copyright = "2026, Oskari Rauta",
			.usage = "[options] <container> [command [args...]]",
			.description = "\nrun a command (default /bin/sh) inside a running uxc container;\n"
			               "a pty is used automatically for an interactive shell on a terminal",
		},
		.options = {
			{ "pty",     { .key = "t", .desc = "force a pty (interactive terminal)" }},
			{ "no-pty",  { .key = "T", .desc = "never allocate a pty" }},
			{ "uid",     { .key = "u", .word = "uid", .desc = "run as uid[:gid] (default: container root)", .flag = usage_t::REQUIRED, .name = "uid[:gid]" }},
			{ "cwd",     { .key = "w", .word = "cwd", .desc = "working directory (default: /)", .flag = usage_t::REQUIRED, .name = "dir" }},
			{ "help",    { .key = "h", .word = "help", .desc = "show this help" }},
			{ "version", { .key = "V", .word = "version", .desc = "show version" }},
		}
	};

	if ( (bool)usage["version"] ) { std::cout << usage.version() << std::endl; return 0; }
	if ( (bool)usage["help"] || ci >= argc ) {
		std::cout << usage << "\n" << usage.help() << std::endl;
		return ci >= argc ? 2 : 0;
	}

	std::string container = argv[ci];

	std::vector<char*> cmd(argv + ci + 1, argv + argc);
	bool default_cmd = cmd.empty();
	if ( cmd.empty())
		cmd.push_back((char*)"/bin/sh");
	cmd.push_back(nullptr);

	int force_pty = (bool)usage["pty"] ? 1 : ( (bool)usage["no-pty"] ? -1 : 0 );
	std::string uidgid = usage["uid"].value;
	std::string cwd = usage["cwd"].value;

	// ask uxcd for the in-container init pid
	long long init_pid = 0;
	bool running = false;
	try {
		ubus u;
		JSON args;
		args["name"] = container;
		JSON info = u.call("uxcd", "info", args);
		if ( info.contains("error")) {
			fprintf(stderr, "uxe: %s\n", info["error"].to_string().c_str());
			return 1;
		}
		running = info.contains("running") && info["running"].to_bool();
		if ( info.contains("init_pid"))
			init_pid = info["init_pid"].to_number();
	} catch ( const ubus::exception& e ) {
		fprintf(stderr, "uxe: cannot reach uxcd over ubus: %s\n", e.what());
		return 1;
	}

	if ( !running || init_pid <= 0 ) {
		fprintf(stderr, "uxe: container '%s' is not running\n", container.c_str());
		return 1;
	}

	// parse uid[:gid]
	uid_t uid = 0;
	gid_t gid = 0;
	bool set_ids = false;
	if ( !uidgid.empty()) {
		set_ids = true;
		std::string us = uidgid, gs;
		size_t c = uidgid.find(':');
		if ( c != std::string::npos ) { us = uidgid.substr(0, c); gs = uidgid.substr(c + 1); }
		uid = (uid_t)atoi(us.c_str());
		gid = gs.empty() ? (gid_t)uid : (gid_t)atoi(gs.c_str());
	}

	// decide whether to use a pty
	bool want_pty = force_pty == 1 ||
	                ( force_pty == 0 && default_cmd && isatty(STDIN_FILENO) && isatty(STDOUT_FILENO));

	// join the container's namespaces, in dependency order; skip any namespace
	// shared with us (same inode).
	static const struct { const char* name; int flag; } NS[] = {
		{ "user", CLONE_NEWUSER }, { "cgroup", CLONE_NEWCGROUP }, { "ipc", CLONE_NEWIPC },
		{ "uts", CLONE_NEWUTS }, { "net", CLONE_NEWNET }, { "pid", CLONE_NEWPID }, { "mnt", CLONE_NEWNS },
	};
	for ( const auto& ns : NS ) {
		char tpath[64], spath[64];
		snprintf(tpath, sizeof tpath, "/proc/%lld/ns/%s", init_pid, ns.name);
		snprintf(spath, sizeof spath, "/proc/self/ns/%s", ns.name);
		struct stat ts, ss;
		if ( stat(tpath, &ts) != 0 )
			continue;
		if ( stat(spath, &ss) == 0 && ts.st_ino == ss.st_ino && ts.st_dev == ss.st_dev )
			continue;
		int fd = open(tpath, O_RDONLY | O_CLOEXEC);
		if ( fd < 0 ) { fprintf(stderr, "uxe: open %s: %s\n", tpath, strerror(errno)); return 1; }
		if ( setns(fd, ns.flag) != 0 ) {
			fprintf(stderr, "uxe: setns %s: %s\n", ns.name, strerror(errno));
			close(fd);
			return 1;
		}
		close(fd);
	}

	// allocate the pty now that we are in the container's mount namespace, so the
	// slave lives in the container's own devpts (ttyname() resolves inside it).
	int slave = -1;
	if ( want_pty ) {
		g_master = posix_openpt(O_RDWR | O_NOCTTY);
		if ( g_master < 0 || grantpt(g_master) || unlockpt(g_master)) {
			fprintf(stderr, "uxe: cannot allocate pty: %s\n", strerror(errno));
			return 1;
		}
		const char* sname = ptsname(g_master);
		slave = sname ? open(sname, O_RDWR | O_NOCTTY) : -1;
		if ( slave < 0 ) {
			fprintf(stderr, "uxe: cannot open pty slave: %s\n", strerror(errno));
			return 1;
		}
	}

	pid_t pid = fork();
	if ( pid < 0 ) {
		fprintf(stderr, "uxe: fork: %s\n", strerror(errno));
		return 1;
	}

	if ( pid == 0 ) {
		if ( want_pty ) {
			if ( g_master >= 0 ) close(g_master);
			setsid();
			ioctl(slave, TIOCSCTTY, 0);
			dup2(slave, STDIN_FILENO);
			dup2(slave, STDOUT_FILENO);
			dup2(slave, STDERR_FILENO);
			if ( slave > STDERR_FILENO ) close(slave);
		}
		if ( chdir(cwd.empty() ? "/" : cwd.c_str()) != 0 )
			(void)chdir("/");
		if ( set_ids ) {
			setgroups(0, nullptr);
			if ( setgid(gid) != 0 || setuid(uid) != 0 ) {
				fprintf(stderr, "uxe: cannot set uid/gid: %s\n", strerror(errno));
				_exit(1);
			}
		}
		execvp(cmd[0], cmd.data());
		fprintf(stderr, "uxe: exec %s: %s\n", cmd[0], strerror(errno));
		_exit(127);
	}

	// parent
	if ( want_pty ) {
		close(slave);
		if ( tcgetattr(STDIN_FILENO, &g_saved_tio) == 0 ) {
			g_tio_saved = true;
			struct termios raw = g_saved_tio;
			cfmakeraw(&raw);
			tcsetattr(STDIN_FILENO, TCSANOW, &raw);
			atexit(restore_tty);
		}
		struct sigaction sa;
		memset(&sa, 0, sizeof sa);
		sa.sa_handler = on_winch;
		sigaction(SIGWINCH, &sa, nullptr);
		pty_relay();
		restore_tty();
	}

	int status = 0;
	while ( waitpid(pid, &status, 0) < 0 && errno == EINTR )
		;
	if ( WIFEXITED(status))
		return WEXITSTATUS(status);
	if ( WIFSIGNALED(status))
		return 128 + WTERMSIG(status);
	return 1;
}
