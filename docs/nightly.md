# The nightly run

`python -m app pack` voices the day's stories once per narrator and publishes them to Supabase.
Everything else follows from that: the clients refuse a day until its narrator is marked ready, so a
morning with no pack shows the previous day instead of something half-made. A story carried by two
Guardian feeds is read once, under the earlier section, so a brief never repeats itself.

Three ways to make it happen while you are away, in the order I would use them.

## 1. This Mac, woken on a schedule (installed and tested)

`scripts/nightly-pack.sh` does the whole thing: starts colima if it is down, brings the voice
service container up, waits for the model to load, loads `.env`, and runs the pack. It logs one file
per day to `~/Library/Logs/morning-brief/pack-YYYY-MM-DD.log`, and `caffeinate` holds the Mac awake
for the length of the render.

The pack is called with `--if-missing`: if the day is already published, it says so and stops. That
matters because a run later in the same day does not reuse the earlier clips. The feed has moved on
by then, so the stories have new URLs and every clip is rendered again, which re-cuts the day's brief
to the afternoon's news while listeners are part way through the morning's. `--force` is the
deliberate version of that: it takes the day off the air first, so nobody hears half of each.

Two more flags ride along on the nightly call and keep the run honest:

- `--notify`. When the day is ready for every narrator, listeners get one push and the admins get a
  line each. When it is not, or the render throws, the admins get the failure instead, with the
  reason. A silent 05:00 failure was the worst part of the old setup.
- The prune. One day of audio is kept: a successful pack deletes the older days, rows and storage
  files together. It only runs when the day is complete for **every** narrator, so a morning that
  failed leaves yesterday's brief in place for clients to fall back on.

### The 06:00 report

`scripts/nightly-report.sh` runs an hour after the pack, which is the point of the gap: a transient
failure has had its chance to clear, and the report describes the final state of the morning rather
than the middle of it.

It checks readiness first, which needs nothing but Python, so a morning that worked costs no
container start. If a narrator is missing, it waits up to 30 minutes for a pack that is still
recording, re-checks, and then brings the voice service up and re-renders the missing narrators once.
Either way the admins get the outcome, and listeners get their nudge if the day was repaired after
the 05:00 run had already failed.

```sh
scripts/nightly-report.sh --dry-run    # readiness only: no retry, no voice service, no report
python -m app pack --check             # the check by itself; exit 1 if the day is incomplete
python -m app pack --report --retry    # check, repair, report
```

It is installed as a LaunchAgent at **05:00 every day**, with the report at **06:00**:

- `~/Library/LaunchAgents/ca.vattitude.morning-brief.pack.plist`
- `~/Library/LaunchAgents/ca.vattitude.morning-brief.report.plist`
- loaded with `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ca.vattitude.morning-brief.pack.plist`

Two things only you can set, both needing sudo:

```sh
# Wake the Mac at 04:45 every day so the 05:00 job has a machine to run on.
sudo pmset repeat wakeorpoweron MTWRFSU 04:45:00

# Or simpler, on power: never let the system sleep at all while plugged in.
sudo pmset -c sleep 0
```

Use one or the other, not both. With `sleep 0` the Mac stays awake on power and launchd runs the job
at 05:00 directly. With the wake line, the Mac sleeps and wakes itself, and launchd runs any job it
missed as soon as the machine is up.

Requirements for this to be reliable: stay logged in (a LaunchAgent runs in your session), stay on
power, and leave the network connected. The display may sleep, the system must not. If the machine is
shut down, or the network is out at 05:00, nothing is published and the clients keep showing the
previous day, which is the safe failure.

Checks, any time:

```sh
tail -f ~/Library/Logs/morning-brief/pack-$(date +%Y-%m-%d).log     # today's run
tail -f ~/Library/Logs/morning-brief/report-$(date +%Y-%m-%d).log   # today's check
launchctl print gui/$UID/ca.vattitude.morning-brief.pack            # loaded? when does it next fire?
scripts/nightly-pack.sh --dry-run                                   # plumbing only, no render
scripts/nightly-pack.sh                                             # the run, by hand
launchctl kickstart -k gui/$UID/ca.vattitude.morning-brief.pack     # run it right now, as launchd would
launchctl kickstart -k gui/$UID/ca.vattitude.morning-brief.report   # the check, right now
```

To stop them: `launchctl bootout gui/$UID/ca.vattitude.morning-brief.pack` (same for `.report`).

## 2. Tailscale, for running it by hand or reading the logs

Tailscale gives you the Mac's shell from anywhere, which is what you want for "did it run?" and for
kicking a run off after a bad morning. It **cannot wake a sleeping Mac**, so it pairs with option 1
rather than replacing it: if you set `sleep 0` on power, the Mac is always reachable; if you let it
sleep, you can only reach it after the 04:45 wake.

```sh
# once, on the Mac: System Settings -> General -> Sharing -> Remote Login, then
ssh vattitude@<tailscale-name> 'cd Coding/Morning_Brief && tail -20 ~/Library/Logs/morning-brief/pack-$(date +%Y-%m-%d).log'
ssh vattitude@<tailscale-name> 'cd Coding/Morning_Brief && scripts/nightly-pack.sh'
```

## 3. Google Cloud, which removes the Mac from the critical path

The durable answer, and the one I would build when you are back. The trial credit covers a long time
because the job is minutes long, not hours.

Shape of it: a GPU instance (an L4 or T4) runs the voice service from
`voice_service/Dockerfile`, and a tiny always-on instance runs the worker, whose schedule starts the
GPU box, runs `python -m app pack` against it, and stops it again. An L4 is roughly $0.70/hour, so a
15 minute nightly run is about $0.18, some $5 a month against a $300 credit.

That also happens to be where the worker belongs in general: it can run the pack and the push
notifications without depending on a laptop being awake, on power, and logged in.

What it needs: the container image built for the GPU, the model weights on a persistent disk (a
one-off download), the Supabase keys in Secret Manager, and the clients pointed at the same Supabase
project they already use, so nothing changes for them. Half a day of work, most of it waiting for the
first image build and the weights.
