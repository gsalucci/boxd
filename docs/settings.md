# Settings

All settings live in `/etc/boxd/boxd.conf` (sh syntax, kept on upgrade). The file shows every setting with its default:

| Setting | Default | Meaning |
|---|---|---|
| `BOXD_USER` | `boxd` | build account |
| `BOXD_WORK` | `/var/lib/boxd/work` | work area (a btrfs subvolume) |
| `BOXD_WORK_FS` | `auto` | how the work area is kept clean: `btrfs` subvolumes, or `dir` (a plain folder refreshed with rsync); `auto` takes btrfs when the file system is btrfs |
| `BOXD_PORT` | `2222` | port of the build sshd |
| `BOXD_TRUSTED_NET` | empty | address range exempt from sshd connection penalties (clients probe the port before ssh) |
| `BOXD_LIMITS`, `BOXD_TTL`, `BOXD_IMAGE`, `BOXD_REGISTRIES` | 12 GB per box, 1800 s, debian, docker.io and ghcr.io | box limits, idle time before a box is removed, default image, allowed registries |
| `BOXD_VM_LIMITS`, `BOXD_VM_MAX`, `BOXD_VM_ENGINE_DISK` | `-c 4 -m 8G` (the `large` size), unset (no count limit; machines are admitted by measured memory), 32G | virtual machine boxes |
| `BOXD_VM_JOB_DISK`, `BOXD_VM_CACHE_DISK` | 64G, 64G | the size of `/job` and of `/cache` in a machine box (the engine limits a mounted folder to 4G unless told; a machine made before 0.4.46 needs `--recreate`) |
| `BOXD_VM_COMMIT` | 100 | percent of the memory cap that the sizes of the running machines may add up to (a young machine has not claimed its memory yet); the memory the running container boxes use now counts too (since 0.4.9) |
| `BOXD_BOX_RESERVE` | 4096 | megabytes a call that starts work in a container box that is not busy must find free, beside the sizes of the running machines and the memory the other container boxes use (a busy one with a call or run begun lately counts at least this much, as a young machine counts its size), within `BOXD_VM_COMMIT` percent of the memory cap; otherwise the call is refused with exit 75 (`no room for another busy box`) and `--wait` waits for room. `0` turns the rule off: container boxes are then limited only by the cap of the whole build group, as before |
| `BOXD_QUEUE_LIVE` | 120 | seconds after which a waiting call's place in line (the ticket of a call made with `box --wait`) counts as given up when it was not asked again; the client asks every 30 seconds, so 120 is four asks (since 0.4.41) |
| `BOXD_VM_IDLE_MIN` | 300 | seconds without use after which a machine with no run or call in it counts as idle (also how long a call or run counts as young for `BOXD_BOX_RESERVE`); idle machines are removed, the longest unused first, when a new machine or a call into a container box has no room otherwise (since 0.4.12 for machines) |
| (not a setting) further client machines | `boxd-setup --add-key <public key file> [--from <addresses>]` | a second key with full run rights, listed in `/etc/boxd/run_keys`; `--remove-key <file>` takes it out |
| `BOXD_MAVEN_MIRROR` | unset | address of a caching repository for Java packages on your own network; every box's Maven uses it in place of the public central source (for machine boxes also list its address and port in `BOXD_VM_NET_ALLOW`) |
| `BOXD_KEEP_DAYS`, `BOXD_EVICT_AT`, `BOXD_EVICT_TO` | 14, 70, 60 (on a disk shared with the system, `boxd-setup` writes lower values once: the fill of the disk plus 20 points rounded up to the next 5 and at most 70, ten less, and 3 days) | retention: a box folder unused for that many days is removed; from that fill level of the file system the work area is on (percent of the whole disk, as `df` shows it) the least recently used folder goes, one per minute, until under the last value. Log: `cache/evictions.log` |
| `BOXD_MEM_MAX`, `BOXD_SWAP_MAX` | 85 % and 25 % of memory, computed when `boxd-sshd` starts; the memory cap less half of the swap the group may put on zram (swap kept in RAM) | caps of the whole build cgroup; `boxd-sshd` logs a warning when a set memory cap plus that zram share is over 90 % of the host's memory |
| `BOXD_CGROUP` | `/sys/fs/cgroup/boxd` (Debian package: `/sys/fs/cgroup/boxd.slice/boxd-sshd.service`) | folder of the build cgroup that holds the caps and that virtual machine admission measures |
| `BOXD_POWER` | `off` | `on` makes `boxctl start` also start the power module |
| `BOXD_IDLE_CHECKS`, `BOXD_IDLE_LOAD_MAX`, `BOXD_RESET_AT`, `BOXD_WIRED`, `BOXD_WIFI` | 20, 0.5, 85, empty, empty | power module only: quiet minutes before sleep, quiet load, disk percent that resets the build area before a sleep, the network cards wake-on-network is armed on (at least one is needed, else the host never sleeps) |

Core boxd never touches sleep or wake settings, running or stopped; only the power module does.
