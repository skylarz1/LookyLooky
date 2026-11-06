Files here are imported on LookyLooky's **first** boot only (mounted at /seed):

- `cameras.xml`: cameras, plus camera-engine settings
- `camera-layouts.xml`: layouts
- `cameras.json`: the camera-proxy format (HTTP cameras with params and session/basic login)
- or a LookyLooky export (Settings → System → Export everything)

Start from `cameras.example.xml` and `camera-layouts.example.xml`. Files with
"example" in their name are never imported.

Real camera files contain passwords. They are git-ignored and never copied
into the Docker image. After the first boot, manage cameras in the dashboard,
or import again from Settings → System.
