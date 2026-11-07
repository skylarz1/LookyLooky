# Running LookyLooky with Docker Desktop on Windows 11

About 30 minutes, most of it waiting on installs and downloads.

## 1. Install Docker Desktop (one time)

1. Download **Docker Desktop for Windows** from <https://www.docker.com/products/docker-desktop/> and run the installer.
2. Leave **"Use WSL 2"** ticked when it asks. That's Windows' built-in Linux support, which Docker needs.
3. Restart the PC when asked.
4. Open **Docker Desktop** from the Start menu. Accept the terms; signing in is optional.
5. Wait for **"Engine running"** (green) in the bottom-left corner.
6. **Settings → General** → tick **"Start Docker Desktop when you sign in to your computer"**. The cameras then come back after a reboot by themselves.

## 2. Get the files

Either download the repository as a ZIP (green **Code** button → **Download ZIP**) and extract it, or:

```powershell
git clone https://github.com/skylarz1/LookyLooky.git C:\LookyLooky
```

Use a folder like **`C:\LookyLooky`**, not OneDrive, Desktop or Documents (OneDrive syncing interferes with Docker). The folder with `docker-compose.yml` in it is "the project folder" below.

## 3. Add your cameras

In the project folder's `config` folder:

- **Cameras:** copy `cameras.example.xml` to **`cameras.xml`** and put your cameras in. Or drop in a `cameras.xml` you already have.
- **Layouts:** copy `camera-layouts.example.xml` to **`camera-layouts.xml`**. Optional.

These files are read on the **first** start only. Afterwards, use the dashboard (or Settings → System → Import). They contain camera passwords and are never uploaded to GitHub.

## 4. Find this PC's network address

1. Start → type **PowerShell** → open it.
2. Run `ipconfig`. Under your Ethernet or Wi-Fi adapter, note the **IPv4 Address**, e.g. `192.168.1.50`.
3. Check the PC can reach a camera: `ping <a camera's IP>`. "Reply from…" is good.

Ask whoever runs the router to give this PC a **reserved (fixed) IP**. If it changes, the iPads lose their connection.

## 5. Edit `docker-compose.yml`

Right-click it → **Open with → Notepad**:

1. **`LOOKY_HOSTNAMES`:** change `192.168.1.10` to **your IP from step 4**.
2. **`TZ`:** your time zone, e.g. `America/New_York`, `America/Denver` or `America/Los_Angeles`.
3. **Recommended:** remove the `# ` in front of `LOOKY_ADMIN_PASSWORD:` and set a password. The dashboard user is `admin`.
4. Save.

Only change text inside the quotes, and leave the spaces at the start of each line as they are.

## 6. Start it

1. In File Explorer, open the project folder, click the address bar, type `powershell` and press Enter.
2. Run:
   ```powershell
   docker compose up -d --build
   ```
   The first run takes a few minutes.
3. Check it:
   ```powershell
   docker compose logs -f
   ```
   Look for `camera(s) added` and `HTTPS on :8443`. **Ctrl+C** stops watching (the server keeps running).

Docker Desktop → **Containers** shows **lookylooky** with a green dot. Click it for the same logs.

## 7. Windows Firewall

Allow Docker on **Private networks** if Windows asks. To be sure, run PowerShell **as Administrator** and enter:

```powershell
New-NetFirewallRule -DisplayName "LookyLooky" -Direction Inbound -Protocol TCP -LocalPort 8080,8443 -Action Allow -Profile Private
```

Also set your network to **Private**: Settings → Network & internet → your connection → Network profile type.

## 8. Open it

**On this PC:** <http://localhost:8080>. Full video works with no certificate here.

**On each iPad (one time):**
1. In **Safari**, go to `https://YOUR-IP:8443/setup.html`. At the "not private" warning, tap **Show Details → visit this website**.
2. **Download the certificate** → **Allow**.
3. **Settings → Profile Downloaded → Install**, then enter the passcode.
4. **Settings → General → About → Certificate Trust Settings** → turn on **LookyLooky Local CA**.
5. Open `https://YOUR-IP:8443/`. Tap a camera once to allow sound.

**Other PCs:** follow the Windows steps on `/setup.html`.

## Day-to-day

Run these in PowerShell in the project folder:

| To… | Run |
|---|---|
| Stop | `docker compose down` |
| Start | `docker compose up -d` |
| Watch the logs | `docker compose logs -f` |
| Update to a newer version | `git pull` (or extract the new ZIP over the old one), then `docker compose up -d --build` |
| Start completely fresh from `config/` | `docker compose down -v` (**deletes** cameras, layouts, settings and recordings), then `docker compose up -d` |

## Troubleshooting

- **A camera is black or says Error:** hover its red dot in the dashboard for the reason, or check the logs.
- **The iPad warns every time:** step 4 of the iPad setup (Certificate Trust Settings) was skipped, or the IP isn't in `LOOKY_HOSTNAMES`. Fix the file, then run `docker compose up -d`. The iPads don't need the certificate again.
- **The iPad can't load the page:** check the firewall (step 7), or the iPad may be on a guest Wi-Fi.
- **"port is already allocated":** something else uses 8080 or 8443. Change the left-hand numbers under `ports:`, e.g. `"9443:8443"`, and set `LOOKY_PUBLIC_HTTPS_PORT: "9443"`.
- **Typed `http://` by mistake:** both ports send you to the secure page by themselves.
- **Multicast cameras take about 8 s to start, and the log says "no picture over multicast":** expected on Docker Desktop. Its VM sits behind NAT, so multicast from the cameras can't reach the container, and each stream switches to normal TCP by itself. To really use multicast, run LookyLooky on a Linux machine with `network_mode: host` (see README, "Multicast"), or set the cameras back to TCP.
