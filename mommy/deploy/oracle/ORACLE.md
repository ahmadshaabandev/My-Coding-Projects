# Run Mommy for free on Oracle Cloud

This guide puts Mommy on a small computer in one of Oracle's data centres (a "virtual
machine", or VM), for free, with Oracle Cloud's "Always Free" offer. Unlike running it
on your own computer ([SELF_HOST.md](../../SELF_HOST.md)), the VM stays on day and
night: your computer can be off, and your friend can use Mommy whenever they like.

You type a few commands; one script does the rest (it installs Docker, downloads
Mommy, starts it and prints the link to send). Count about an hour the first time:
half for the Oracle account and the VM, half for the setup to download and build.

You get one of two kinds of link:

- **The quick tunnel (the default):** `https://some-random-words.trycloudflare.com/#code=...`,
  through a free Cloudflare quick tunnel. Nothing to open on Oracle's side. The link
  changes when the tunnel restarts (when the VM restarts, and sometimes after an
  update).
- **A permanent link (optional, step 6):** `https://129-146-10-20.sslip.io/#code=...`,
  made from the VM's own address. It does not change. It needs two ports opened in
  Oracle's console (exact clicks below).

Either way the **access code** in the link protects Mommy: without it, a visitor only
sees a page that asks for a code.

What you need:

- An email address, a mobile phone, and a **credit or debit card** in your name. Oracle
  uses the card to check who you are; the Always Free resources this guide uses are
  not charged. (Prepaid and virtual cards are often refused.)
- A computer with **Windows 10 or 11** (PowerShell) or a **Mac** (Terminal), to type the
  commands. You need it only for the setup and for changes, not to run Mommy.

---

## 1. Sign up for Oracle Cloud Free Tier

1. Go to <https://www.oracle.com/cloud/free/> and click **Start for free**.
2. Fill in the form: country, name, email. Oracle sends an email to check the address;
   click its link, then choose a password.
3. **Cloud Account Name:** a short name for your account (for example `mommy-family`).
   Write it down: you type it each time you sign in.
4. **Home Region: choose carefully, it cannot be changed later.** The free VM can only be
   made in this region. Choose the region nearest to you and your friend (the list
   shows the cities): the nearer it is, the faster Mommy answers. Free Ampere VMs are
   sometimes "out of capacity" in a region (step 2 says what to do); owners often
   report that the busiest regions run out more often than smaller ones nearby.
5. Address and phone number (Oracle may send a code by SMS), then the card. Oracle may
   put a small temporary amount on hold to check the card, then release it.
6. Wait for the email that says your account is ready. It can take from a few minutes
   to a few hours.

Your new account also includes a free trial of paid services for a limited time. You
need none of it: use only what this guide says (see step 8, "Staying free").

## 2. Create the VM

1. Sign in at <https://cloud.oracle.com/>: type your **Cloud Account Name**, then your
   email and password.
2. Open the menu (☰, top left) > **Compute** > **Instances**, then click **Create
   instance**.
3. **Name:** `mommy`.
4. **Image and shape:** click **Edit** in that section.
   - **Change image** > **Ubuntu** > **Canonical Ubuntu 24.04** (not the one marked
     "Minimal") > **Select image**.
   - **Change shape** > **Virtual machine** > **Ampere** > **VM.Standard.A1.Flex**. Set
     **Number of OCPUs** to **2** and **Amount of memory (GB)** to **12**, then **Select
     shape**. The shape shows the label **Always Free-eligible**.
5. **Networking:** keep what is proposed the first time (a new virtual cloud network
   and a new public subnet), and keep **Automatically assign public IPv4 address**
   turned on.
6. **Add SSH keys:** choose **Generate a key pair for me**, then click **Save private
   key**. Your browser saves a file such as `ssh-key-2026-11-12.key` (in Downloads).
   **Keep this file safe and private: it is the only way into the VM**, and Oracle
   cannot give it to you again. (**Save public key** is optional.)
7. **Boot volume:** leave it as it is.
8. Click **Create**. After a minute or two the state turns to **Running** (green).
   On the instance's page, copy the **Public IP address** (four numbers with dots, for
   example `129.146.10.20`; this guide writes `203.0.113.10`, put yours instead).

The names of buttons above are those of Oracle's console in 2026; Oracle sometimes
moves or renames them a little.

**"Out of capacity for shape VM.Standard.A1.Flex"** when you click Create: Oracle has
no free Ampere machine left in that place right now. It is common and not your fault.

- If the **Placement** section offers several availability domains (AD-1, AD-2, AD-3),
  pick another one and click **Create** again.
- Or try again later: capacity comes and goes during the day.
- Or make it with **1 OCPU and 6 GB** now (Mommy runs, more slowly), and later change
  it: instance page > **Edit** > **Edit shape** > 2 OCPUs and 12 GB (the VM restarts).
- Do not make several VMs to try: the free allowance counts all your Ampere VMs
  together (step 8).

## 3. Connect to the VM

You "connect" with SSH: the commands you type then run on the VM.

### On Windows (PowerShell)

Open **PowerShell** (Start menu, type `PowerShell`, Enter), then:

1. Put the key in your `.ssh` folder (type the beginning of the name, then press Tab to
   complete it):

   ```powershell
   mkdir -Force "$HOME\.ssh"
   Move-Item "$HOME\Downloads\ssh-key-2026-11-12.key" "$HOME\.ssh\mommy-oracle.key"
   ```

2. Connect (with your VM's address):

   ```powershell
   ssh -i "$HOME\.ssh\mommy-oracle.key" ubuntu@203.0.113.10
   ```

   The first time it asks `Are you sure you want to continue connecting
   (yes/no/[fingerprint])?`: type `yes` and press Enter.

If Windows says **`WARNING: UNPROTECTED PRIVATE KEY FILE!`** or **`Permissions for
'...mommy-oracle.key' are too open`**, make the file yours alone, then connect again:

```powershell
icacls "$HOME\.ssh\mommy-oracle.key" /inheritance:r /grant:r "$($env:USERNAME):(R)"
```

If it says **`ssh` is not recognized**: Settings > search "Optional features" > **Add a
feature** (or **View features**) > **OpenSSH Client** > Install, then open a new
PowerShell window.

### On a Mac (Terminal)

Open **Terminal** (Applications > Utilities > Terminal), then:

```sh
mkdir -p ~/.ssh
mv ~/Downloads/ssh-key-2026-11-12.key ~/.ssh/mommy-oracle.key
chmod 600 ~/.ssh/mommy-oracle.key
ssh -i ~/.ssh/mommy-oracle.key ubuntu@203.0.113.10
```

(Use your key's real file name and your VM's address. The first time, answer `yes`.)

### Without a terminal: Oracle Cloud Shell

In Oracle's console, click the **Cloud Shell** icon (`>_`, top right). A terminal opens
at the bottom of the page. Upload the key file with its menu (**Upload**), then:

```sh
chmod 600 ssh-key-2026-11-12.key
ssh -i ssh-key-2026-11-12.key ubuntu@203.0.113.10
```

**You are connected** when the prompt looks like `ubuntu@mommy:~$`. To leave the VM
later, type `exit`.

## 4. Run the setup

On the VM, copy these two commands (they are the same on Windows and on a Mac, since
they run on the VM):

```sh
git clone --branch claude/laughing-goodall-h48bdw https://github.com/ahmadshaabandev/My-Coding-Projects.git ~/mommy-app
bash ~/mommy-app/mommy/deploy/oracle/setup.sh
```

The script shows its progress in 9 steps (`==> [1/9] Checking this machine`, and so
on). **The first time takes 20 to 40 minutes**: it installs Docker, makes a swap file,
downloads Mommy and its speech models (about 1 GB) and builds it. It ends with your
link:

```text
Your link to share (it contains the access code: send it in a private message):

https://some-random-words.trycloudflare.com/#code=abcd2efgh3jk
Reminder: this link changes when the tunnel restarts (after a reboot, for example), but the code stays the same: run this command again to get the new link.
On this VM, get the current link with: bash ~/mommy-app/mommy/deploy/oracle/setup.sh --link
```

- It is **safe to run again**. If it stops with `ERROR`, read the message just above
  it, fix what it says, and run the same command again. If the connection drops (your
  computer went to sleep, say), connect again and run it again.
- It never shows the access code anywhere but in that last link.
- It works on the VM only (Ubuntu 22.04 or 24.04): on anything else it stops and says why.

If `git` is "command not found" (not the case on Oracle's Ubuntu image), first run
`sudo apt-get update && sudo apt-get install -y git`.

## 5. Share the link

1. **Open the link yourself first**, on your phone or computer. You see the code page
   for a moment, then Mommy. A brand-new tunnel can take a minute or two to answer: if
   it does not open, wait and try again.
2. **Send the full link to your friend in a private message**, with this note:
   - en: "Open this link in Safari or Chrome (not inside a messaging app)."
   - fr: « Ouvrez ce lien dans Safari ou Chrome (pas dans une application de
     messagerie). »
   - ar: «يُرجى فتح هذا الرابط في Safari أو Chrome (لا داخل تطبيق مراسلة).»

   The part after `#` is the code: browsers never send it to any server, and Mommy
   removes it from the address bar at once. The browser then remembers it for 180
   days, for this address.

To see the current link again at any time (after connecting as in step 3):

```sh
bash ~/mommy-app/mommy/deploy/oracle/setup.sh --link
```

With the quick tunnel, **the link changes when the VM restarts** (Oracle's maintenance,
or `sudo reboot`), and when an update restarts the tunnel: run that command and send the
new link. The code stays the same.

## 6. Optional: a permanent link

With the quick tunnel, the link changes from time to time. The permanent link,
`https://203-0-113-10.sslip.io/#code=...` (your VM's address, with dashes), does not:

- **sslip.io** is a free public name service: the name `203-0-113-10.sslip.io` simply
  leads to the address `203.0.113.10`. No account.
- **Caddy**, a web server that runs next to Mommy on the VM, gets a free HTTPS
  certificate for that name from **Let's Encrypt** by itself, and renews it.
- Visitors then come straight to your VM (no Cloudflare), on ports 80 and 443, which
  must be opened in **two places**: in Oracle's network (below, in the console), and
  in the VM's own firewall (the script does it).

**A. Open ports 80 and 443 in Oracle's network** (the VCN security list):

1. In the console: ☰ > **Compute** > **Instances** > click **mommy**.
2. On the instance's page, find the **Primary VNIC** (on the **Networking** tab, or in
   the "Instance details" part) and click the name of its **Subnet**.
3. On the subnet's page, under **Security Lists** (or the **Security** tab), click
   **Default Security List for vcn-...**.
4. Go to its **Ingress Rules** (or **Security rules**) and click **Add Ingress Rules**.
5. Fill in:
   - **Source Type:** CIDR
   - **Source CIDR:** `0.0.0.0/0`
   - **IP Protocol:** TCP
   - **Source Port Range:** leave it empty
   - **Destination Port Range:** `80`
   - **Description:** `Mommy HTTP`
6. Click **+ Another Ingress Rule** and fill in the same, with **Destination Port
   Range** `443` and **Description** `Mommy HTTPS`.
7. Click **Add Ingress Rules**. The list now shows the two new rules (next to the rule
   for port 22, which is SSH: leave it).

**B. Switch Mommy to the permanent link**, on the VM:

```sh
bash ~/mommy-app/mommy/deploy/oracle/setup.sh --stable
```

It finds the VM's public address, opens ports 80 and 443 in the VM's firewall (and
keeps them open after a restart), stops the quick tunnel, starts Caddy, checks that
the HTTPS address works with a valid certificate, and prints the permanent link. The
code does not change. From now on, `setup.sh` (for an update) and `setup.sh --link`
keep this mode.

If it warns that the address `does not answer with a valid certificate yet`, the ports
are usually not open in the security list (part A): check the two rules, then run the
same `--stable` command again.

To go back to the quick tunnel: `bash ~/mommy-app/mommy/deploy/oracle/setup.sh --tunnel`
(you can then delete the two rules of part A).

Good to know: every HTTPS certificate is written in public logs, so the name with your
VM's address becomes public, and automated scanners will knock at it. They only ever
see the page that asks for the code.

## 7. Every day

- **Nothing to do.** The VM runs day and night. Mommy starts by itself when the VM
  restarts, and again if it ever stops on an error.
- **The current link:** `bash ~/mommy-app/mommy/deploy/oracle/setup.sh --link`
  (with the quick tunnel, after a restart of the VM, send the new link).
- **After an update** (new Mommy code on the branch): run the setup again. It updates
  the code, rebuilds, restarts, and keeps the mode, the code and Docker's data:

  ```sh
  bash ~/mommy-app/mommy/deploy/oracle/setup.sh
  ```

  It also updates Docker. Ubuntu installs its own security updates by itself; when
  `sudo reboot` is suggested at login ("System restart required"), do it, wait two
  minutes, connect again, and run `--link`.
- **A new code** (a lost link, or to shut out everyone who had the old one):

  ```sh
  bash ~/mommy-app/mommy/deploy/oracle/setup.sh --new-code
  ```

  It saves a new code, restarts Mommy with it and prints the new link. (It does what
  `docker compose exec mommy python -m mommy.share_link --new-code` followed by
  `docker compose restart mommy` does.) The old link, and every browser that used it,
  then get the code page. Send the new link.
- **To stop Mommy:** `cd ~/mommy-app/mommy && sudo docker compose down` (the code is
  kept). To start it again: run the setup.
- **To look inside:** in `~/mommy-app/mommy`, `sudo docker compose ps` (what runs),
  `sudo docker compose logs mommy` (the app; also `tunnel` or `caddy`).

Do not edit the files in `~/mommy-app` by hand: the setup puts such changes aside
(`git stash`) when it updates. Its own settings are in `~/mommy-app/mommy/.env`
(no secrets in it).

## 8. Staying free

- **Never more than 2 OCPUs and 12 GB of memory of Ampere A1 in total**, for all your
  Ampere VMs together. Oracle reduced the allowance from 4 OCPUs and 24 GB, and going
  over it disables the Ampere VMs (as of late 2026; this guide could not check Oracle's
  page itself). The VM of this guide uses all of it, so make no
  other Ampere VM. (The setup warns if this VM alone is larger.) Oracle changes these
  limits from time to time: its page "Always Free Resources" has the current ones.
- **Add nothing that is not "Always Free-eligible":** no other VM shape, no extra disk,
  no load balancer, no paid service. Keep the boot volume as it was made.
- **Do not upgrade the account to "Pay As You Go"** unless you mean to pay for
  something: an upgraded account is billed for anything beyond the free allowance.
- **Idle VMs can be reclaimed.** Oracle may stop an Always Free VM that looks unused:
  over 7 days, its CPU, its network and (for Ampere) its memory all stay under 20% (as
  95th percentiles). Mommy should not look idle: it loads its speech models when it
  starts and keeps them in memory, about 3.4 GB of the VM's 12 GB (about 30%), even
  when nobody uses it (measured in a test: 3.35 GiB of memory in use by the app, not
  cache, while its CPU stayed under 1%). How sure is this? Fairly sure, not certain:
  the memory figure was measured, but Oracle does not say exactly how it measures
  memory, and it can change the rule. If Oracle ever stops the VM: console > Compute >
  Instances > mommy > **Start**, then `--link` for the new link.
- **Sign in to the console from time to time** (once a month, say). Some owners report
  that Oracle closed free accounts that nobody had used for a long time; we found no
  published rule, so this is uncertain, but signing in costs nothing. Keep the
  account's email address working: Oracle sends its notices there.

## 9. What leaves your friend's device

- **The child's voice recordings, the photos and the texts** go from your friend's
  browser over **HTTPS** to the VM in Oracle's data centre:
  - with the quick tunnel, through Cloudflare, whose servers end the HTTPS connection
    and pass the request through the tunnel (also encrypted) to the VM;
  - with the permanent link, straight to the VM, where Caddy ends the HTTPS connection.
    Let's Encrypt only sees the name when it issues the certificate; sslip.io only
    answers which address the name leads to.

  On the VM, Mommy checks them **in memory and keeps none of them**: nothing is written
  to disk. Oracle runs the machine, its memory and its network.
- **The logs** (`sudo docker compose logs`) hold only sizes and timings, never
  recordings, photos, texts, the code or your friend's address. Caddy keeps no list of
  visits, and its error messages leave out the visitor's address. Docker keeps at most
  30 MB of log for each container, on the VM.
- **The family data** (the children, tasks, stars, rewards and the parent PIN) stays in
  the browser on each person's own device, never on the VM.
- **This setup runs Mommy without Claude**: page photos and handwriting are not read
  automatically (the parent types the text), and nothing is sent to the Claude API.
- **The code** is kept on the VM in a Docker volume (a file readable by Mommy only),
  never in a log or in `~/mommy-app`. It travels only inside the link, after the `#`.
- **The SSH key** opens the VM: keep it private, and do not send it to anyone.

## Troubleshooting

- **"Out of capacity"** when creating the VM: see step 2.
- **ssh: "Connection timed out"**: check the address (the instance's **Public IP
  address**) and that the VM is **Running**. **"Permission denied (publickey)"**: the
  user must be `ubuntu` and the key the one saved in step 2.
- **The setup stopped with `ERROR`:** the lines above it say why. Fix it and run the
  same command again; nothing is lost.
- **The tunnel link does not open:** wait a minute and try again. Then, in
  `~/mommy-app/mommy`: `sudo docker compose logs tunnel`. `Registered tunnel connection`
  means it works; `failed to request quick Tunnel` means Cloudflare's free service did
  not answer: wait a few minutes, then `sudo docker compose restart tunnel` and
  `bash ~/mommy-app/mommy/deploy/oracle/setup.sh --link` for the new link. Cloudflare
  offers quick tunnels with no guarantee: if it happens often, use the permanent link.
- **The permanent link does not open** (the setup warned about the certificate):
  check the two rules of step 6, part A. `sudo docker compose logs caddy` in
  `~/mommy-app/mommy` says more: `Timeout during connect (likely firewall problem)`
  means a port is closed; `rateLimited` means too many tries: wait an hour. Then run
  `bash ~/mommy-app/mommy/deploy/oracle/setup.sh --stable` again.
- **Your friend sees the code page:** the link arrived without its end (some apps cut
  it at `#`), it is an old link (after `--new-code`), or it was opened in another
  browser or a private window. Send the full link again, or the code alone (the 12
  characters after `#code=`), which can be typed on the code page. After 10 wrong
  codes in 10 minutes, that connection must wait up to 10 minutes.
- **Your friend sees "This site can't be reached" or a Cloudflare error:** with the
  quick tunnel, the link is old (the VM restarted): run `--link` and send the new one.
  Otherwise the VM may be stopped: start it in the console (step 8).
- **Is it running?** In `~/mommy-app/mommy`: `sudo docker compose ps` shows `mommy` as
  `healthy`. `free -h` shows the memory.

---

For the technically curious: `deploy/oracle/setup.sh` has comments on every step;
`deploy/oracle/compose.oracle.yaml` (both modes) and `deploy/oracle/compose.stable.yaml`
with `deploy/oracle/Caddyfile` (the permanent link) go on top of `compose.yaml`, listed
in `mommy/.env` so that every `docker compose` command in `~/mommy-app/mommy` uses them.
