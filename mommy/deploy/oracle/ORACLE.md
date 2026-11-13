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
  update). Each new link starts empty in your friend's browser (children, tasks and
  stars are saved per address) until your friend loads a copy of the family list saved
  before (step 5).
- **A permanent link (optional, step 6):** `https://129-146-10-20.sslip.io/#code=...`,
  made from the VM's own address. It does not change. It needs two ports opened in
  Oracle's console (exact clicks below). Recommended if your friend uses Mommy for more
  than a few days: their children, tasks and stars stay.

Either way the **access code** in the link protects Mommy: without it, a visitor only
sees a page that asks for a code.

What you need:

- An email address, a mobile phone, and a **credit or debit card** in your name. Oracle
  uses the card to check who you are; the Always Free resources this guide uses are
  not charged. (Oracle does not accept prepaid, virtual or single-use cards, nor debit
  cards that need a PIN.)
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
7. At your first sign-in, Oracle may ask you to set up multi-factor authentication (a
   code from an app on your phone, besides the password). Set it up and keep it on: the
   account can reach the VM too. (This guide could not check whether Oracle always asks
   for it.)

Your new account also includes a free trial of paid services for a limited time. You
need none of it: use only what this guide says (see step 8, "Staying free").

## 2. Create the VM

1. Sign in at <https://cloud.oracle.com/>: type your **Cloud Account Name**, then your
   email and password.
2. Open the menu (☰, top left) > **Compute** > **Instances**, then click **Create
   instance**.
3. **Name:** `mommy`.
4. **Image and shape** (click **Edit** first if this part is folded). Change the shape
   first, then the image:
   - **Change shape** > **Virtual machine** > **Ampere** > **VM.Standard.A1.Flex**. Set
     **Number of OCPUs** to **2** and **Amount of memory (GB)** to **12**, then **Select
     shape**. The shape shows the label **Always Free-eligible**.
   - **Change image** > **Ubuntu** > **Canonical Ubuntu 24.04** (not the one marked
     "Minimal") > **Select image**. The image's build name contains `aarch64` (the
     Ampere kind); if it does not, choose the shape again, then the image.
5. **Networking:** keep what is proposed the first time (a new virtual cloud network
   and a new public subnet), and keep **Automatically assign public IPv4 address**
   turned on.
6. **Add SSH keys:** choose **Generate a key pair for me**, then click **Save private
   key**. Your browser saves a file named `ssh-key-` followed by the day's date and
   `.key` (in Downloads). **Keep this file safe and private: it is the only way into
   the VM**, and Oracle cannot give it to you again. (**Save public key** is optional.)
   (In a console that shows the form as steps, this part may be in the **Networking**
   step.)
7. **Boot volume:** leave it as it is.
8. Click **Create**. (In a console that shows the form as steps, click **Next** until
   the last step, **Review**, then **Create**.) After a minute or two the state turns
   to **Running** (green).
   On the instance's page, copy the **Public IP address** (four numbers with dots, for
   example `129.146.10.20`; this guide writes `203.0.113.10`, put yours instead).

The names of buttons above are those of Oracle's console in 2026; Oracle sometimes
moves or renames them a little.

**"Out of capacity for shape VM.Standard.A1.Flex"** or **"Out of host capacity"** when
you click Create: Oracle has no free Ampere machine left in that place right now. It is
common and not your fault.

- If the **Placement** section offers several availability domains (AD-1, AD-2, AD-3),
  pick another one and click **Create** again.
- Or try again later: capacity comes and goes, and it can take days.
- Or make it with **1 OCPU and 6 GB** now, and later change it: instance page >
  **Edit** > **Edit shape** > 2 OCPUs and 12 GB (the VM restarts; this too can answer
  "out of capacity": try again another day), then connect again and run the setup
  again: it uses the second core and prints the new link. On 1 OCPU, Mommy works, with
  two costs:
  - Each check takes about 1.8 times as long. In a test of one core against two (on
    another kind of processor than Oracle's, so the times on the VM differ), an
    8-second Arabic recitation took 6.2 s to check instead of 3.5 s.
  - Memory is tight. Once each language has been used, Mommy holds about 6 GB, so the
    setup's warning that memory "will be tight" is expected. The swap file it makes
    takes the rest, and a check in a language not used for a while can then be slower.
- Do not make several VMs to try: the free allowance counts all your Ampere VMs
  together (step 8).

## 3. Connect to the VM

You "connect" with SSH: the commands you type then run on the VM.

### On Windows (PowerShell)

Open **PowerShell** (Start menu, type `PowerShell`, Enter), then:

1. Put the key in your `.ssh` folder:

   ```powershell
   mkdir -Force "$HOME\.ssh"
   Move-Item "$HOME\Downloads\ssh-key-*.key" "$HOME\.ssh\mommy-oracle.key"
   ```

   (This works when Downloads holds one such key; otherwise type its full name.)

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

(If you sign in to Windows with a Microsoft or work account and it still complains, put
your full account name instead of `$($env:USERNAME)`: `whoami` prints it.)

If it says **`ssh` is not recognized**: Settings > search "Optional features" > **Add a
feature** (or **View features**) > **OpenSSH Client** > Install, then open a new
PowerShell window.

### On a Mac (Terminal)

Open **Terminal** (Applications > Utilities > Terminal), then:

```sh
mkdir -p ~/.ssh
mv ~/Downloads/ssh-key-*.key ~/.ssh/mommy-oracle.key
chmod 600 ~/.ssh/mommy-oracle.key
ssh -i ~/.ssh/mommy-oracle.key ubuntu@203.0.113.10
```

(Use your VM's address. The `mv` line works when Downloads holds one such key;
otherwise type its full name. If macOS asks whether Terminal may access your Downloads
folder, click **Allow**. The first time, answer `yes`.)

### Optional: a passphrase on the key

Anyone who gets the key file can get into the VM. To make it ask for a passphrase of
your choice each time you connect (the same command on Windows and on a Mac):

```sh
ssh-keygen -p -f ~/.ssh/mommy-oracle.key
```

(On Windows, `~` is your user folder there too.)

### Without a terminal: Oracle Cloud Shell

In Oracle's console, click the **Cloud Shell** icon (`>_`, top right). A terminal opens
at the bottom of the page. Upload the key file with its menu (**Upload**), then:

```sh
mv ssh-key-*.key mommy-oracle.key
chmod 600 mommy-oracle.key
ssh -i mommy-oracle.key ubuntu@203.0.113.10
```

Cloud Shell keeps its files: when you are done, `rm mommy-oracle.key` deletes the key
from it (upload it again the next time).

**You are connected** when the prompt looks like `ubuntu@mommy:~$`. To leave the VM
later, type `exit`.

## 4. Run the setup

On the VM, copy these two commands (they are the same on Windows and on a Mac, since
they run on the VM):

```sh
[ -d ~/mommy-app ] || git clone --branch claude/laughing-goodall-h48bdw https://github.com/ahmadshaabandev/My-Coding-Projects.git ~/mommy-app
bash ~/mommy-app/mommy/deploy/oracle/setup.sh
```

(The first line downloads Mommy's files, and does nothing if they are already there.)

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
- Right after the VM is made, Ubuntu finishes its own setup and updates: the script
  says so and waits (up to 15 minutes) instead of stopping.

If `git` is "command not found" (not the case on Oracle's Ubuntu image), first run
`sudo apt-get update && sudo apt-get install -y git`.

## 5. Share the link

1. **Open the link yourself first**, on your phone or computer. You see the code page
   for a moment, then Mommy. A brand-new tunnel can take a minute or two to answer: if
   it does not open, wait and try again.
2. **Send the full link to your friend in a private message**, with this note:
   - en: "Open this link in Safari or Chrome (not inside a messaging app). If it stops
     working one day, ask me for the new link."
   - fr: « Ouvrez ce lien dans Safari ou Chrome (pas dans une application de
     messagerie). S'il ne fonctionne plus un jour, demandez-moi le nouveau lien. »
   - ar: «يُرجى فتح هذا الرابط في Safari أو Chrome، وليس داخل تطبيق مراسلة. إذا توقّف
     الرابط عن العمل يومًا ما، يُرجى طلب الرابط الجديد منّي.»

   The part after `#` is the code: browsers never send it to any server, and Mommy
   removes it from the address bar at once. The browser then remembers it for 180
   days, for this address.

To see the current link again at any time (after connecting as in step 3):

```sh
bash ~/mommy-app/mommy/deploy/oracle/setup.sh --link
```

With the quick tunnel, **the link changes when the VM restarts** (Oracle's maintenance,
or `sudo reboot`), and when an update restarts the tunnel: run that command and send the
new link. The code stays the same, but Mommy starts empty for your friend at the new
address. To bring the children, tasks, stars and rewards back, your friend needs a
**copy of the family list** saved before, while the old link still worked:

1. In Mommy: **For parents** (with the parent PIN) > **Settings** > **Save a copy**. The
   browser saves a file `mommy-family-<date>.json` (it holds the children's names and
   age groups, their tasks, stars and rewards, but not the PIN or the consents; it is
   not encrypted, so it should stay private).
2. At the new link, on Mommy's first screen: **Load a copy**, pick the file, tick the
   consent box, choose a PIN, then **Let's start**. (A family that already started there
   uses **Settings** > **Load a copy**, which replaces that browser's list.)

So ask your friend to save a copy before a reboot or an update, and now and then in case
of Oracle's maintenance ([SELF_HOST.md](../../SELF_HOST.md), step 5, "Moving the family
list to a new link", has a note to send in English, French and Arabic). The permanent
link (step 6) avoids all this.

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

**B. Switch Mommy to the permanent link**, on the VM. The permanent link is a new
address: first ask your friend to save a copy of the family list (step 5), and to load
it at the permanent link afterwards.

```sh
bash ~/mommy-app/mommy/deploy/oracle/setup.sh --stable
```

It finds the VM's public address (two services that tell it must agree), opens ports
80 and 443 in the VM's firewall (and keeps them open after a restart), stops the quick
tunnel, starts Caddy, checks that the HTTPS address works with a valid certificate, and
prints the permanent link. The code does not change. From now on, `setup.sh` (for an
update) and `setup.sh --link` keep this mode.

If it warns that the address `does not answer with a valid certificate yet`, it does not
print the link (the code would go to an address that may not lead to your VM): the
ports are usually not open in the security list (part A). Check the two rules, then run
the same `--stable` command again.

If the VM's public address ever changes, the permanent link's address changes with it,
and the setup also makes a **new code** (the old link would lead to an address Oracle
may give to someone else): send the new link.

Very old Android phones (Android 7.0 and older) may show a certificate warning for the
permanent link: Let's Encrypt's certificates need a newer phone. If your friend's phone
does, use the quick tunnel instead.

To go back to the quick tunnel: `bash ~/mommy-app/mommy/deploy/oracle/setup.sh --tunnel`
(a new address again: a copy of the family list first, as above).
It closes ports 80 and 443 in the VM's firewall again; you can then delete the two rules
of part A.

Good to know: every HTTPS certificate is written in public logs, so the name with your
VM's address becomes public, and automated scanners will knock at it. They only ever
see the page that asks for the code.

## 7. Every day

- **Nothing to do.** The VM runs day and night. Mommy starts by itself when the VM
  restarts, and again if it ever stops on an error.
- **The current link:** `bash ~/mommy-app/mommy/deploy/oracle/setup.sh --link`
  (with the quick tunnel, after a restart of the VM, send the new link).
- **After an update** (new Mommy code on the branch): with the quick tunnel, first ask
  your friend to save a copy of the family list (step 5), in case the link changes. Then
  run the setup again. It updates the code, rebuilds, restarts, and keeps the mode, the
  code and Docker's data:

  ```sh
  bash ~/mommy-app/mommy/deploy/oracle/setup.sh
  ```

  It first shows the update (from which version to which, its date and title, and
  whether it changes the files that run with full rights on the VM) and asks `Install
  this update? [y/N]`: type `y` if you expected new code, anything else to keep the
  version you have. If it warns that the history was rewritten, install it (by typing
  `yes`) only if whoever looks after Mommy told you so.

  It also updates Docker. Ubuntu installs its own security updates by itself; when
  `sudo reboot` is suggested at login ("System restart required"), ask your friend to
  save a copy of the family list first (quick tunnel), do it, wait two minutes, connect
  again, and run `--link`.
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
  over it disables the Ampere VMs, which Oracle then deletes after 30 days (Free Tier
  FAQ; the numbers as of late 2026, which this guide could not check on Oracle's page
  itself). The VM of this guide uses all of it, so make no
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
- **Sign in to the console at least every three weeks** (a calendar reminder helps).
  Oracle's Free Tier FAQ says that an account left idle for 30 days or more may be
  treated as abandoned, then suspended or closed. It does not say what counts as
  activity, nor whether a running VM is enough, so sign in to be safe. Keep the
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
- **The logs** (`sudo docker compose logs`) hold sizes and timings, the language and
  kind of each check and the ayat numbers of a Quran check, never recordings, photos,
  texts, the age group, the code or your friend's address. Caddy keeps no list of
  visits, and its error messages leave out the visitor's address. Docker keeps at most
  30 MB of log for each container, on the VM.
- **The family data** (the children, tasks, stars, rewards and the parent PIN) stays in
  the browser on each person's own device, never on the VM. A copy saved with **Save a
  copy** is a file (without the PIN or the consents, not encrypted) where that browser
  saves downloads: usually the Downloads folder, and on an iPhone the Files app, which may
  be iCloud Drive. Mommy makes it and reads it in the browser and never sends it to the
  VM.
- **This setup runs Mommy without Claude**: a photo of a printed page is read, if at
  all, by Mommy itself on the VM (no outside AI service), handwriting is not read
  automatically (the parent types what the child wrote), and nothing is sent to the
  Claude API.
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
  quick tunnel, the link is old (the VM restarted): run `--link` and send the new one
  (the family list comes back with **Load a copy**, from a copy saved before: step 5).
  Otherwise the VM may be stopped: start it in the console (step 8).
- **Is it running?** In `~/mommy-app/mommy`: `sudo docker compose ps` shows `mommy` as
  `healthy`. `free -h` shows the memory.

---

For the technically curious: `deploy/oracle/setup.sh` has comments on every step;
`deploy/oracle/compose.oracle.yaml` (both modes) and `deploy/oracle/compose.stable.yaml`
with `deploy/oracle/Caddyfile` (the permanent link) go on top of `compose.yaml`, listed
in `mommy/.env` so that every `docker compose` command in `~/mommy-app/mommy` uses them.
To install one given version, `MOMMY_REF=<a tag or a full commit id> bash
~/mommy-app/mommy/deploy/oracle/setup.sh` uses it instead of the branch's latest commit
(a run without `MOMMY_REF` offers the branch's latest commit again).
