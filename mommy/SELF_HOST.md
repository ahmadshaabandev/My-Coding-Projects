# Run Mommy on your own computer and share it with a friend

This guide puts Mommy on your own computer, for free, and gives you a private link that
works from anywhere (a phone on mobile data, another country). You do not need to know
Docker: you type two commands, one to start Mommy and one to get the link.

How it works, in short:

- **Docker Desktop** runs Mommy on your computer in a closed box (a "container"), the
  same way on Windows, on a Mac and on Linux.
- **A free Cloudflare quick tunnel** gives Mommy an address such as
  `https://some-random-words.trycloudflare.com`. You need no Cloudflare account, and you
  do not touch your router: nothing on your home network is opened.
- **An access code** protects it. Only people who have your link (it contains the code)
  can use Mommy. Anyone else sees a page that asks for a code.

What you need:

- Windows 10 or 11 (64-bit), or a Mac (Intel or Apple Silicon: M1, M2, M3 and later).
  Linux works too (see the note at the end).
- **8 GB of RAM or more.** Mommy uses 4 to 5 GB while it runs.
- **About 6 GB of free disk space.**
- About 1 GB to download the first time, and 10 to 20 minutes.

The computer must stay on (and awake) while your friend uses Mommy. If it cannot,
[deploy/oracle/ORACLE.md](deploy/oracle/ORACLE.md) runs the same Mommy for free on a
small computer in Oracle's cloud, which stays on day and night.

---

## 1. Install Docker Desktop

1. Go to the official download page: <https://www.docker.com/products/docker-desktop/>
   and download Docker Desktop for your computer:
   - **Windows:** "Download for Windows – AMD64" (almost every PC; "– ARM64" only for
     a Windows on Arm laptop, such as one with a Snapdragon chip).
   - **Mac:** "Download for Mac – Apple Silicon" for an M1, M2, M3 or later chip, or
     "Download for Mac – Intel Chip" for an Intel Mac. To check which one you have:
     Apple menu > About This Mac: the line "Chip" (Apple) or "Processor" (Intel).
2. Install it:
   - **Windows:** run `Docker Desktop Installer.exe`. Keep **"Use WSL 2 instead of
     Hyper-V (recommended)"** ticked: the installer turns WSL 2 on for you (WSL 2 is the
     part of Windows that runs Linux programs such as Mommy). Restart the computer if it
     asks. If Docker Desktop later says that WSL needs an update, open PowerShell and
     run `wsl --update`.
   - **Mac:** open the downloaded `Docker.dmg` and drag Docker into Applications.
3. Open Docker Desktop (Windows: Start menu; Mac: Applications). Accept the terms when it
   asks. Signing in to a Docker account is not needed: you can skip it. Wait until the
   bottom-left corner of its window says **Engine running**.
4. **Give it enough memory.** Mommy needs at least 6 GB inside Docker.

   - **Mac:** in Docker Desktop, click the gear icon (Settings) > **Resources** >
     **Advanced**. Set **Memory limit** to **6 GB or more** (8 GB if your Mac has 16 GB of
     RAM or more), check that **Disk usage limit** leaves about 6 GB free, then click
     **Apply & restart**.
   - **Windows:** with WSL 2, Docker Desktop's Settings > Resources page has no memory
     slider (it says that Windows manages the resources). WSL 2 gets half of the PC's
     memory by default, so:
     - **16 GB of RAM or more:** nothing to do (WSL 2 already has 8 GB).
     - **8 to 15 GB of RAM:** give it 6 GB. Open **PowerShell** (Start menu, type
       `PowerShell`, Enter) and paste this line, then press Enter:

       ```powershell
       if (Test-Path "$env:USERPROFILE\.wslconfig") { notepad "$env:USERPROFILE\.wslconfig" } else { Set-Content -Path "$env:USERPROFILE\.wslconfig" -Value "[wsl2]","memory=6GB" }
       ```

       (If Notepad opens instead, you already had that file: make sure it has a line
       `[wsl2]` and, under it, a line `memory=6GB`, then save and close Notepad.)
       Then run `wsl --shutdown`, and quit and reopen Docker Desktop (right-click the
       whale icon near the clock > Quit Docker Desktop).

   **Check it**, on Windows or Mac: open PowerShell (Windows) or Terminal (Mac,
   Applications > Utilities > Terminal) and run:

   ```sh
   docker info
   ```

   Find the line **Total Memory**: it should say about **5.7 GiB or more**. (If you see
   an error instead, Docker Desktop is not running yet: see Troubleshooting.)

## 2. Get Mommy's files

**Option A, the ZIP file (simplest).**

1. Download this file:
   <https://github.com/ahmadshaabandev/My-Coding-Projects/archive/refs/heads/claude/laughing-goodall-h48bdw.zip>
   (it saves as `My-Coding-Projects-claude-laughing-goodall-h48bdw.zip`, 1 to 2 MB).
2. Unzip it:
   - **Windows:** in File Explorer, right-click the ZIP in Downloads > **Extract All...**
     > **Extract** (keep the folder it proposes).
   - **Mac:** Safari unzips it by itself; otherwise double-click the ZIP in Downloads.
3. Open a terminal **in the `mommy` folder**:
   - **Windows (PowerShell):**

     ```powershell
     cd "$HOME\Downloads\My-Coding-Projects-claude-laughing-goodall-h48bdw\My-Coding-Projects-claude-laughing-goodall-h48bdw\mommy"
     ```

     (Windows puts the files one folder deeper, hence the name twice.) If this says
     that the path does not exist, use File Explorer instead: open the folders until you
     see the `mommy` folder, open it (you see `compose.yaml` inside), click in the
     address bar at the top, type `powershell` and press Enter: PowerShell opens in that
     folder.
   - **Mac (Terminal):**

     ```sh
     cd ~/Downloads/My-Coding-Projects-claude-laughing-goodall-h48bdw/mommy
     ```

     If this says "No such file or directory", type `cd` and a space, drag the `mommy`
     folder from Finder onto the Terminal window, and press Enter.

**Option B, with Git** (if you use Git):

```sh
git clone --branch claude/laughing-goodall-h48bdw https://github.com/ahmadshaabandev/My-Coding-Projects.git
cd My-Coding-Projects/mommy
```

Either way, check that you are in the right folder: `ls` (Mac, or PowerShell) lists
`compose.yaml` among the files. **Every `docker compose` command below is run in this
`mommy` folder.**

## 3. Start Mommy

```sh
docker compose up -d --build
```

The first time takes **10 to 20 minutes** and downloads about **1 GB** (mostly the
speech models, about 730 MB). You see many lines of progress. It is done when the last
lines say something like:

```text
 ✔ Container mommy-mommy-1   Healthy
 ✔ Container mommy-tunnel-1  Started
```

and the prompt comes back. Docker Desktop's **Containers** page then shows **mommy**
with its two containers running. Later starts take a few seconds.

Mommy makes its access code the first time it starts and keeps it (in Docker, not in
the folder). It never prints it in a log.

## 4. Get the link and send it

```sh
docker compose exec mommy python -m mommy.share_link
```

It prints the link, then a reminder:

```text
https://some-random-words.trycloudflare.com/#code=abcd2efgh3jk
Reminder: this link changes when the tunnel restarts (after a reboot, for example), but the code stays the same: run this command again to get the new link.
```

(If it says "Waiting for the tunnel to start", it waits up to a minute by itself.)

1. **Open the link once yourself** (in Chrome, Edge, Safari or Firefox). You see the
   code page for a moment, then Mommy. If it does not open yet, wait a minute and try
   again: a new tunnel can take a little while to be reachable.
2. **Send the full link to your friend in a private message.** The part after `#` is
   the code; it never reaches any server's logs (browsers do not send it), and Mommy
   removes it from the address bar at once. A note to send with it:
   - en: "Open this link in Safari or Chrome (not inside a messaging app)."
   - fr: « Ouvrez ce lien dans Safari ou Chrome (pas dans une application de
     messagerie). »
   - ar: «يُرجى فتح هذا الرابط في Safari أو Chrome (لا داخل تطبيق مراسلة).»

   A messaging app's own browser keeps its cookies apart and may not allow the
   microphone. Your friend's browser then remembers the code for 180 days, for this
   address (a new link has a new address: send the full new link each time).

**On your own computer** you can also use <http://localhost:8080>: it asks for the same
code. Open the link above with its beginning replaced by `http://localhost:8080`, that is
`http://localhost:8080/#code=` followed by your code, or type the code on the code page.

## 5. Every day

- **Keep the computer on and awake, with Docker Desktop running.** When the computer
  sleeps, Mommy and the link stop answering.
  - Windows: Settings > System > Power & sleep (Windows 10) or Power & battery
    (Windows 11): set the sleep time "when plugged in" to **Never** while your friend
    uses Mommy.
  - Mac: run `caffeinate -i` in a Terminal window and leave it open while your friend
    uses Mommy (Ctrl+C stops it). A MacBook still sleeps when its lid is closed.
  - Docker Desktop > Settings > General > **Start Docker Desktop when you sign in to
    your computer**: tick it, so Mommy comes back by itself after a restart.
- **After a restart of the computer** (or of Docker Desktop), in the `mommy` folder:

  ```sh
  docker compose up -d
  docker compose exec mommy python -m mommy.share_link
  ```

  **The link changes** (a new `trycloudflare.com` address) and **the code stays the
  same**: send the new link to your friend.
- **To stop Mommy:**

  ```sh
  docker compose down
  ```

  The code is kept. `docker compose up -d` starts it again (with a new link).
- **To update Mommy** after new code is available: get the new files (download the ZIP
  again and unzip it in place of the old folder, or `git pull` in the Git folder), open
  the terminal in the `mommy` folder again, and run:

  ```sh
  docker compose up -d --build
  ```

  The code is kept (it is stored in Docker, not in the folder). Run the `share_link`
  command again afterwards: the link may have changed.
- **To make a new code** (a lost link, or to shut out everyone who had the old one):

  ```sh
  docker compose exec mommy python -m mommy.share_link --new-code
  docker compose restart mommy
  ```

  The first command saves a new code and prints the new link; the second makes Mommy
  use it. From then on, the old link and every browser that used it get the code page.
  Send the new link.
- **To remove Mommy completely** (the code too): `docker compose down --volumes --rmi all`.
  You can then uninstall Docker Desktop.

## 6. Troubleshooting

- **"Cannot connect to the Docker daemon"** (Mac), **"error during connect"** or
  **"open //./pipe/dockerDesktopLinuxEngine"** (Windows), or **"docker: command not
  found"**: Docker Desktop is not running (or not installed yet). Open it and wait until
  it says **Engine running**, then run the command again.
- **"no configuration file provided: not found"**: the terminal is not in the `mommy`
  folder (step 2, point 3).
- **Not enough memory.** `docker compose ps` shows `mommy` as **Restarting (137)**,
  or your friend's page keeps saying that Mommy is starting. Look at the end of the
  app's log:

  ```sh
  docker compose logs mommy
  ```

  If it stops without an error message and starts again from its first line
  (`space_start.sh: access gate on`), Docker ran out of memory: give Docker more memory
  (step 1, point 4), close other programs, then `docker compose up -d`.
- **The link is not ready yet.** `share_link` says "Waiting for the tunnel to start",
  or "No link: the tunnel did not answer", or "the tunnel is not connected to Cloudflare
  yet". Check the tunnel:

  ```sh
  docker compose ps
  docker compose logs tunnel
  ```

  - `Registered tunnel connection` in the log: the tunnel works; open the link again
    in a minute.
  - `failed to request quick Tunnel`: Cloudflare's quick-tunnel service did not answer,
    or this network blocks it (some work or school networks do). The tunnel tries again
    by itself; wait a few minutes, or try another network, then run `share_link` again.
- **Your friend sees the code page** instead of Mommy: the link arrived without its end
  (some apps cut it at `#`), it is an old link (after `--new-code`), or it was opened in
  another browser or a private window. Send the full link again, or send the code (the
  12 characters after `#code=`) in a separate message: it can be typed on the code page.
  After 10 wrong codes in 10 minutes, that connection must wait up to 10 minutes.
- **Your friend sees a Cloudflare error page or "This site can't be reached":** the
  link is old (your computer or Docker restarted, so the tunnel has a new address), or
  your computer is asleep or off. Run `share_link` and send the new link.
- **"port is already allocated"** when starting: another program on your computer uses
  port 8080 (for example Mommy started with `./run.sh`). Stop it, or open `compose.yaml`
  in a text editor and change `"127.0.0.1:8080:7860"` to `"127.0.0.1:8081:7860"`
  (Mommy is then at <http://localhost:8081>).
- **Limits of a free quick tunnel.** Cloudflare offers quick tunnels for testing, with
  no guarantee that they are always available: a tunnel may occasionally stop
  answering (`docker compose restart tunnel` makes a new one, with a new link). It
  carries at most about 200 requests at the same time, far more than one family needs.
  Its address is random and changes every time the tunnel starts.

## 7. What leaves your computer

- **Your friend's child's voice recordings, the photos and the texts** go from your
  friend's browser over **HTTPS** to Cloudflare, which carries them through the tunnel
  (also encrypted) to your computer. Cloudflare's servers end the HTTPS connection, as
  any such service does. On your computer, Mommy checks them **in memory and keeps
  none of them**: nothing is written to disk.
- **The logs** (`docker compose logs`) hold only sizes and timings, never recordings,
  photos, texts, the code or your friend's address. Docker keeps them on your computer
  (at most 30 MB for each of the two containers) and deletes them with the containers
  (`docker compose down`).
- **The family data** (the children, tasks, stars, rewards and the parent PIN) stays in
  the browser on each person's own device: your friend's on your friend's phone or
  computer, never on yours.
- **This setup runs Mommy without Claude**: page photos and handwriting are not read
  automatically (the parent types the text), and nothing is sent to the Claude API.
- **Your home network stays closed:** the tunnel only connects out to Cloudflare. The
  app's port answers only on this computer (`localhost`), not to other devices at home.
- **The code** is kept in a Docker volume on your computer (file mode 0600, readable by
  Mommy only). It is never written in a log, an image or in this folder.

## Linux

Install Docker Engine and its Compose plugin from Docker's instructions for your
distribution (<https://docs.docker.com/engine/install/>), so that `docker compose
version` works. Then follow steps 2 to 7 in a terminal: the commands are the same (put
`sudo` in front of them unless your user is in the `docker` group). Docker on Linux has
no memory limit of its own: the computer needs 8 GB of RAM or more. To start Mommy at
boot, enable Docker (`sudo systemctl enable --now docker`); the containers then come
back by themselves (run `share_link` for the new link).

---

For the technically curious: `compose.yaml` holds the whole setup (two services, `mommy`
built from the `Dockerfile` and `tunnel` running a pinned `cloudflared`), with comments.
`compose.test.yaml` is for testing the kit only and is not used here.
