// uxexec - run a command (default: an interactive shell) inside a running uxc
// container managed by uxcd. It asks uxcd over ubus for the container's
// in-container init pid, then setns()es into that process's namespaces and execs
// the command - the same mechanism as `nsenter`/`docker exec`.
//
// Namespaces that the container shares with the host (e.g. the net ns of a
// host-network container, or the user ns) are detected by inode and skipped, so
// joining them never fails with EINVAL.

#include <string>
#include <vector>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>

#include <unistd.h>
#include <fcntl.h>
#include <sched.h>
#include <grp.h>
#include <sys/stat.h>
#include <sys/wait.h>

#include "ubus.hpp"
#include "json.hpp"
#include "version.hpp"

static void usage(void) {
	fprintf(stderr,
		"uxexec " UXCD_VERSION " - run a command inside a running uxc container\n"
		"\n"
		"usage: uxexec [-u uid[:gid]] [-w cwd] <container> [command [args...]]\n"
		"\n"
		"  -u uid[:gid]  run as this uid (and gid); default: container's root\n"
		"  -w cwd        working directory inside the container; default: /\n"
		"  -V            print version and exit\n"
		"\n"
		"  the default command is /bin/sh\n");
}

int main(int argc, char** argv) {

	std::string uidgid, cwd;
	int opt;
	while (( opt = getopt(argc, argv, "+u:w:hV")) != -1 ) {
		switch ( opt ) {
			case 'u': uidgid = optarg; break;
			case 'w': cwd = optarg; break;
			case 'V': printf("uxexec %s\n", UXCD_VERSION); return 0;
			case 'h': usage(); return 0;
			default:  usage(); return 2;
		}
	}

	if ( optind >= argc ) { usage(); return 2; }
	std::string container = argv[optind++];

	std::vector<char*> cmd;
	for ( int i = optind; i < argc; i++ )
		cmd.push_back(argv[i]);
	if ( cmd.empty())
		cmd.push_back((char*)"/bin/sh");
	cmd.push_back(nullptr);

	// ask uxcd for the in-container init pid
	long long init_pid = 0;
	bool running = false;
	try {
		ubus u;
		JSON args;
		args["name"] = container;
		JSON info = u.call("uxcd", "info", args);
		if ( info.contains("error")) {
			fprintf(stderr, "uxexec: %s\n", info["error"].to_string().c_str());
			return 1;
		}
		running = info.contains("running") && info["running"].to_bool();
		if ( info.contains("init_pid"))
			init_pid = info["init_pid"].to_number();
	} catch ( const ubus::exception& e ) {
		fprintf(stderr, "uxexec: cannot reach uxcd over ubus: %s\n", e.what());
		return 1;
	}

	if ( !running || init_pid <= 0 ) {
		fprintf(stderr, "uxexec: container '%s' is not running\n", container.c_str());
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

	// join the container's namespaces, in dependency order. Skip any namespace
	// the container shares with us (same inode) - setns into our own ns would
	// fail (user) or be pointless.
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
			continue;                       // container has no such ns
		if ( stat(spath, &ss) == 0 && ts.st_ino == ss.st_ino && ts.st_dev == ss.st_dev )
			continue;                       // shared with us -> nothing to join

		int fd = open(tpath, O_RDONLY | O_CLOEXEC);
		if ( fd < 0 ) {
			fprintf(stderr, "uxexec: open %s: %s\n", tpath, strerror(errno));
			return 1;
		}
		if ( setns(fd, ns.flag) != 0 ) {
			fprintf(stderr, "uxexec: setns %s: %s\n", ns.name, strerror(errno));
			close(fd);
			return 1;
		}
		close(fd);
	}

	// the pid namespace only takes effect for children, so fork after setns.
	pid_t pid = fork();
	if ( pid < 0 ) {
		fprintf(stderr, "uxexec: fork: %s\n", strerror(errno));
		return 1;
	}

	if ( pid == 0 ) {
		if ( chdir(cwd.empty() ? "/" : cwd.c_str()) != 0 )
			(void)chdir("/");
		if ( set_ids ) {
			setgroups(0, nullptr);
			if ( setgid(gid) != 0 || setuid(uid) != 0 ) {
				fprintf(stderr, "uxexec: cannot set uid/gid: %s\n", strerror(errno));
				_exit(1);
			}
		}
		execvp(cmd[0], cmd.data());
		fprintf(stderr, "uxexec: exec %s: %s\n", cmd[0], strerror(errno));
		_exit(127);
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
