# Security policy

## Supported versions

Only the latest release gets security fixes. Upgrade to it before you report, if you can.

## Report a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting: open the "Security" tab of this repository,
then "Report a vulnerability". Only the maintainer sees the report.

A usable report has:

- the version of the client (`box --version`), the version of the server package, and the distribution of the build server;
- the engine of the box (container or virtual machine);
- the steps to reproduce, with the exact commands and the exact output;
- what an attacker gains, meaning which guarantee below breaks;
- your proposed fix, if you have one.

Replace machine names and addresses you do not want shared, and never include a real secret.

## What is in scope

The security model is written in the README. A report is in scope when it shows that one of these guarantees breaks:

- The build account can do one thing over ssh: talk to `boxd-pod`. A way to run anything else as that account, or to
  go beyond what `boxd-pod` allows, is in scope.
- Boxes are isolated from each other. A box that reads, changes or stops the files or processes of another box is in scope.
- A secret reaches a command only through `--env`. A secret that leaks into a command line, a file or a log is in scope.

Out of scope: a build server whose owner gave the build account more access than the packages do, and software you
run inside your own box.
