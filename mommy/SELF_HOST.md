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
- **Good to know:** the children, tasks, stars and rewards are saved in each person's
  own browser, for one address. The tunnel's address changes each time it restarts
  (when your computer or Docker Desktop restarts), and with a new address Mommy starts
  empty again in your friend's browser (what was saved stays tied to the old address,
  which no longer works). So avoid restarts while your friend uses Mommy, and ask your
  friend to **save a copy** of the family list (in Mommy: **For parents** > **Settings**
  > **Save a copy**) before a restart or an update, and now and then in case of an
  unplanned one: at the new link, **Load a copy** on Mommy's first screen brings it back
  (see "Moving the family list to a new link" in step 5). A copy can only be saved while
  the old link still works. For a link that never changes, see
  [deploy/oracle/ORACLE.md](deploy/oracle/ORACLE.md), step 6.

What you need:

- **Windows 11** (version 23H2 or later) or **Windows 10 version 22H2**, 64-bit (Settings
  > System > About shows yours). Docker supports a Windows version only while Microsoft
  does, so Windows 10 may stop working with new versions of Docker Desktop. Or **a Mac**
  with one of the three newest macOS versions (Apple menu > About This Mac shows yours),
  Intel or Apple Silicon (M1, M2, M3 and later). Linux works too (see the note at the
  end).
- **8 GB of RAM or more.** Mommy uses 4 to 5 GB while it runs.
- **About 10 GB of free disk space**: Docker Desktop takes about 3 GB, and Mommy about
  5 GB (the app with its speech models, and what Docker keeps from building it).
- The first start downloads about 1 GB (plus about 0.5 GB for Docker Desktop) and takes
  10 to 30 minutes, depending on your internet connection.

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
   - **Windows:** first turn on WSL 2, the part of Windows that runs Linux programs such
     as Mommy (once per computer). Start menu, type `PowerShell`, right-click **Windows
     PowerShell** > **Run as administrator** > **Yes**, then run:

     ```powershell
     wsl --install --no-distribution
     ```

     Restart the computer when it is done. (If it says that WSL is already installed,
     run `wsl --update` instead. If it does not know `--no-distribution`, run
     `wsl --install`: it also installs Ubuntu, which Mommy does not need; if an Ubuntu
     window opens after the restart and asks for a user name, you can close it.) Then
     run `Docker Desktop Installer.exe` and keep what it proposes: a **per-user**
     installation and the **WSL 2** backend. Restart the computer if it asks.
   - **Mac:** open the downloaded `Docker.dmg` and drag Docker into Applications.
3. Open Docker Desktop (Windows: Start menu; Mac: Applications). Mac: if macOS asks
   whether to open an app downloaded from the internet, click **Open**; if Docker offers
   **Use recommended settings**, keep it and type your Mac password. Accept the terms when
   it asks. Signing in to a Docker account is not needed: you can skip it. Wait until the
   bottom-left corner of its window says **Engine running**.
4. **Give it enough memory.** Mommy needs at least 6 GB inside Docker.

   - **Mac:** in Docker Desktop, click the gear icon (Settings) > **Resources** >
     **Advanced**. Set **Memory limit** to **6 GB or more** (8 GB if your Mac has 16 GB of
     RAM or more), then click **Apply & restart**.
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
       Then quit Docker Desktop (right-click the whale icon near the clock > **Quit
       Docker Desktop**), run `wsl --shutdown`, wait 10 seconds, and open Docker Desktop
       again.

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

     If macOS asks whether Terminal may access files in your Downloads folder, click
     **Allow**. If this says "No such file or directory", type `cd` and a space, drag the
     `mommy` folder from Finder onto the Terminal window, and press Enter.

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

The first time takes **10 to 30 minutes** (depending on your internet connection) and
downloads about **1 GB** (mostly the speech models, about 730 MB). You see many lines of progress. It is done when the last
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
   - en: "Open this link in Safari or Chrome (not inside a messaging app). If it stops
     working one day, ask me for the new link."
   - fr: « Ouvrez ce lien dans Safari ou Chrome (pas dans une application de
     messagerie). S'il ne fonctionne plus un jour, demandez-moi le nouveau lien. »
   - ar: «يُرجى فتح هذا الرابط في Safari أو Chrome، وليس داخل تطبيق مراسلة. إذا توقّف
     الرابط عن العمل يومًا ما، يُرجى طلب الرابط الجديد منّي.»

   A messaging app's own browser keeps its cookies apart and may not allow the
   microphone. Your friend's browser then remembers the code for 180 days, for this
   address (a new link has a new address: send the full new link each time, and Mommy
   starts empty there until your friend loads a copy of the family list, see "Good to
   know" at the top).

**On your own computer** you can also use <http://localhost:8080>: it asks for the same
code. Open the link above with its beginning replaced by `http://localhost:8080`, that is
`http://localhost:8080/#code=` followed by your code, or type the code on the code page.

## 5. Every day

- **Keep the computer on and awake, with Docker Desktop running.** While it sleeps,
  Mommy and the link do not answer; when it wakes up they come back by themselves, with
  the same link.
  - Windows: Settings > System > Power & battery (Windows 11) or Power & sleep
    (Windows 10): set the sleep time when plugged in to **Never**. On a laptop, also
    Control Panel > Hardware and Sound > Power Options > **Choose what closing the lid
    does** > When I close the lid, Plugged in: **Do nothing**. Windows Update may restart
    the computer at night, which makes a new link: set your usual hours in Settings >
    Windows Update > Advanced options > **Active hours**.
  - Mac: run `caffeinate -i` in a Terminal window and leave it open while your friend
    uses Mommy (Ctrl+C stops it). A MacBook still sleeps when its lid is closed.
  - Docker Desktop > Settings > General > **Start Docker Desktop when you sign in to
    your computer**: tick it, so Mommy comes back by itself after a restart.
- **After a restart of the computer** (or of Docker Desktop): wait until Docker Desktop
  says **Engine running**, then run this in any PowerShell or Terminal window (no need
  to go to the `mommy` folder):

  ```sh
  docker exec mommy-mommy-1 python -m mommy.share_link
  ```

  **The link changes** (a new `trycloudflare.com` address) and **the code stays the
  same**: send the new link to your friend. With a new link, Mommy starts empty for your
  friend: **Load a copy** on its first screen brings back a copy saved before the
  restart (see "Moving the family list to a new link" below); without one, the children
  and tasks have to be added again. If it says `No such container`, Mommy was stopped:
  start it in the `mommy` folder, then run the command above again:

  ```sh
  docker compose up -d
  ```
- **To stop Mommy:**

  ```sh
  docker compose down
  ```

  The code is kept. `docker compose up -d` starts it again (with a new link: ask your
  friend to save a copy of the family list first).
- **To update Mommy** when there is new code:
  1. First ask your friend to save a copy of the family list (the link may change; see
     "Moving the family list to a new link" below), and wait until it is done.
  2. ZIP: in Downloads, delete the old folder
     `My-Coding-Projects-claude-laughing-goodall-h48bdw` and the old ZIP (your code is
     kept in Docker, not there). Then do step 2 again: download, Extract All, open the
     terminal in the new `mommy` folder. Git: run `git pull` in the `mommy` folder.
  3. Run:

     ```sh
     docker compose up -d --build
     ```

     Only Mommy is rebuilt and restarted: the code stays the same, and usually so does
     the link. Run the `share_link` command to check: if the link changed, send the new
     one, and your friend loads the copy there. Afterwards, `docker image prune -f` frees
     the space of the old version.

  If `share_link` says that the tunnel program is many months old, an update brings a
  newer one (when the new files have one): Cloudflare supports each version for about a
  year.
- **Moving the family list to a new link.** The list lives in your friend's browser, for
  one address, so it does not follow a new link by itself; your friend moves it with a
  file:
  1. **Before** the restart or the update, while the old link still works: in Mommy,
     **For parents** (with the parent PIN) > **Settings** > **Save a copy**. The browser
     saves a file named `mommy-family-<date>.json` (usually in Downloads; on an iPhone,
     in the Files app). It holds the children's names and age groups, their tasks,
     stars and rewards, but not the PIN and not the consents. It is not encrypted: it
     should stay on your friend's device or somewhere private.
  2. **At the new link**, Mommy starts on its first screen: **Load a copy** (under the
     language), pick that file, check what it shows (the children, their tasks and
     stars), tick the consent box, choose a PIN (the same one or a new one), then
     **Let's start**. The children, tasks, stars and rewards are back.

  A family that already started at the new link can load the copy in **Settings** >
  **Load a copy** instead: it replaces that browser's list (the PIN and the consents
  there stay). A note to send before a restart or an update:
  - en: "Before I restart Mommy, please save a copy of your family list: For parents >
    Settings > Save a copy. With the new link, choose Load a copy on the first screen."
  - fr: « Avant que je redémarre Mommy, enregistrez une copie de la liste de votre
    famille : Pour les parents > Réglages > Enregistrer une copie. Avec le nouveau lien,
    choisissez Charger une copie sur le premier écran. »
  - ar: «قبل إعادة تشغيل Mommy، يُرجى حفظ نسخة من قائمة العائلة: للكبار > الإعدادات >
    حفظ نسخة. ومع الرابط الجديد، يُرجى اختيار فتح نسخة في الشاشة الأولى.»
- **To make a new code** (a lost link, or to shut out everyone who had the old one):

  ```sh
  docker compose exec mommy python -m mommy.share_link --new-code
  docker compose restart mommy
  ```

  The first command saves a new code and prints the new link; the second makes Mommy
  use it. From then on, the old link and every browser that used it get the code page.
  Send the new link.
- **To remove Mommy completely** (the code too): `docker compose down --volumes --rmi all`,
  then `docker builder prune -a -f` (frees what Docker kept from building it, about
  1.5 GB). You can then uninstall Docker Desktop.

## 6. Troubleshooting

- **"Cannot connect to the Docker daemon"** (Mac), **"error during connect"** or
  **"open //./pipe/dockerDesktopLinuxEngine"** (Windows), **"docker: command not
  found"**, or in PowerShell **"The term 'docker' is not recognized"**: Docker Desktop is
  not running (or not installed yet). Open it and wait until it says **Engine running**,
  then run the command again. If Docker Desktop is running, close PowerShell and open a
  new window (a window opened before the installation does not know the new command).
- **"Virtualization support not detected"** (Windows) or **"Incompatible CPU
  detected"** (Mac): hardware virtualization is turned off in the computer's firmware
  (BIOS/UEFI) settings, often under the name "Intel Virtualization Technology" or "SVM
  Mode". The computer maker's help pages say how to turn it on.
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
  - Still "not connected" after five minutes: `docker compose restart tunnel` (this
    makes a new link), then run `share_link` again.
- **Your friend sees the code page** instead of Mommy: the link arrived without its end
  (some apps cut it at `#`), it is an old link (after `--new-code`), or it was opened in
  another browser or a private window. Send the full link again, or send the code (the
  12 characters after `#code=`) in a separate message: it can be typed on the code page.
  After 10 wrong codes in 10 minutes, that connection must wait up to 10 minutes.
- **Your friend sees a Cloudflare error page or "This site can't be reached":** the
  link is old (your computer or Docker restarted, so the tunnel has a new address), or
  your computer is asleep or off. Wake it up and run `share_link`: if it prints the same
  link, it works again within a minute; if it prints another one, send that one.
- **"address already in use"**, **"port is already allocated"** or **"ports are not
  available"**, with `8080` in the message, when starting: another program on this
  computer already uses port 8080 (for example Mommy started with `./run.sh`), and Mommy
  does not start at all, nor does the link. Stop that program, or open `compose.yaml` in
  Notepad (Windows) or TextEdit (Mac), find the line `- "127.0.0.1:8080:7860"`, change
  only `8080` to `8081`, save, and run `docker compose up -d` again. On this computer
  Mommy is then at <http://localhost:8081>; the link does not change.
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
- **The logs** (`docker compose logs`) hold sizes and timings, the language and kind of
  each check and the ayat numbers of a Quran check, never recordings, photos, texts,
  the age group, the code or your friend's address. Docker keeps them on your computer
  (at most 30 MB for each of the two containers) and deletes them with the containers
  (`docker compose down`).
- **The family data** (the children, tasks, stars, rewards and the parent PIN) stays in
  the browser on each person's own device: your friend's on your friend's phone or
  computer, never on yours. A copy saved with **Save a copy** is a file (without the PIN
  or the consents, not encrypted) where that browser saves downloads: usually the
  Downloads folder, and on an iPhone the Files app, which may be iCloud Drive. Mommy makes
  it and reads it in the browser and never sends it to your computer.
- **This setup runs Mommy without Claude**: page photos and handwriting are not read
  automatically (the parent types the text), and nothing is sent to the Claude API.
- **Your home network stays closed:** the tunnel only connects out to Cloudflare. The
  app's port answers only on this computer (`localhost`), not to other devices at home
  (on Linux, with Docker Engine 28 or later: see the Linux note). Even so, it asks for
  the code.
- **The code** is kept in a Docker volume on your computer (file mode 0600, readable by
  Mommy only). It is never written in a log, an image or in this folder.

## Linux

Install Docker Engine and its Compose plugin from Docker's instructions for your
distribution (<https://docs.docker.com/engine/install/>), so that `docker compose
version` works. Use **Docker Engine 28 or later** (`docker version --format
'{{.Server.Version}}'` shows it): older versions let another device of your network
that routes to Docker's addresses reach the app's port, which only the code then
protects. Some distributions' own packages are older (Ubuntu 24.04's first `docker.io`
is 24.0, Debian 12's is 20.10): Docker's own packages are current. Then follow steps 2
to 7 in a terminal: the commands are the same (put `sudo` in front of them unless your
user is in the `docker` group). Docker on Linux has
no memory limit of its own: the computer needs 8 GB of RAM or more. To start Mommy at
boot, enable Docker (`sudo systemctl enable --now docker`); the containers then come
back by themselves (run `share_link` for the new link).

---

For the technically curious: `compose.yaml` holds the whole setup (two services, `mommy`
built from the `Dockerfile` and `tunnel` running a pinned `cloudflared`), with comments.
`compose.test.yaml` is for testing the kit only and is not used here.
