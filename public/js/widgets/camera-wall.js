// Relative imports, so the wall loads the same whether a page on LookyLooky
// imports it or a page in another stack imports it from LookyLooky's origin.
import { Widget, SetHtml } from "./widgets.js";
import { CameraGrid, webCodecsAvailable } from "../camera/viewer.js";

/**
 * Camera Wall (LookyLooky)
 * ========================
 *
 * The camera board as a widget: one main pane over two rows of three
 * previews, click a preview to put it up, audio follows the main pane, and the
 * main pane follows the game when the host says which objective is in play.
 *
 * It talks to the page over `noodleman` (see /js/noodleman.js — a
 * Subscribe/Broadcast bus with postMessage and cross-tab bridges), and the
 * wall runs in two modes:
 *
 *   STORY MODE (the original): the layout comes from the story —
 *     noodleman.stories[storyID].Options.CameraLayoutID — and changes with it.
 *     The host publishes 'story-set' / 'story-id' / 'story' / 'settings' /
 *     'current-objective' on noodleman exactly as it did on noodleman.
 *
 *   FIXED MODE: `layout` is given in the options (wall.html?layout=… does
 *     this).  No story is needed; 'wall-layout' { layout } switches it and
 *     'select-camera' { cameraId } puts a camera up.  'current-objective'
 *     still works.
 *
 * Options:
 *   id        element id to render into (or `element`)
 *   layout    fixed layout id or name                              (fixed mode)
 *   storyid   story to follow                                      (story mode)
 *   api       LookyLooky origin when the page is served elsewhere, e.g.
 *             "https://cams.example.lan:8443" — every /api call and the
 *             media socket go there.  Default: this page's own origin.
 *   poll      camera status poll, ms (default 5000; layouts at twice that)
 *
 * The stylesheet is /styles/camera-wall.css; every rule there is scoped to
 * .claudifer-wall, so it can be linked into any host page.  The wall's element
 * needs a definite height (the stylesheet sizes the 16:9 main pane against it).
 *
 * SECURE CONTEXT
 * --------------
 * Full motion is WebCodecs, exposed only in a secure context.  Without it the
 * wall still builds — every pane as a JPEG thumbnail — rather than going black.
 */
export default class CameraWall extends Widget {

    /**
     * The wall is the camera service's '7f' grid: one main pane over rows of
     * previews. ShapeLayout() re-labels every layout as 7f, and the wall's
     * CameraGrid is given a 7f with room for every preview (see Start).
     *
     * Up to six previews sit three to a row, as they always have. A room with
     * more -- seven or eight cameras is common -- puts them four to a row
     * instead of dropping the extras off the end, up to twelve.
     *
     * The main pane is not an extra camera -- it is a view onto whichever of
     * the previews is selected.
     */
    static PANES_PER_ROW = 3;
    static WIDE_PANES_PER_ROW = 4;
    static PREVIEW_PANES = 12;

    /** Previews per row: three for up to six, four past that. */
    static PerRow(previews) {
        return previews <= 2 * CameraWall.PANES_PER_ROW ? CameraWall.PANES_PER_ROW : CameraWall.WIDE_PANES_PER_ROW;
    }

    /* The camera dashboard's own speaker glyphs, so the control reads the same
       on both. Crossed out when muted, waves when not. */
    static ICON_MUTED =
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round">'
      + '<polygon points="4 7 8 7 13 3 13 17 8 13 4 13" fill="currentColor" stroke="none"/>'
      + '<line x1="15" y1="8" x2="19" y2="12"/><line x1="19" y1="8" x2="15" y2="12"/></svg>';

    static ICON_SOUND =
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"'
      + ' stroke-linecap="round" stroke-linejoin="round">'
      + '<polygon points="4 7 8 7 13 3 13 17 8 13 4 13" fill="currentColor" stroke="none"/>'
      + '<path d="M15.5 7.5a3.5 3.5 0 0 1 0 5"/><path d="M17.5 5.5a6 6 0 0 1 0 9"/></svg>';

    constructor(options = {}) {
        super(options);

        const sourceID = options.id != null ? options.id : "";

        this.Name = "Camera Wall: #" + sourceID;
        this.parentID = "#" + sourceID;
        this.Parent = options.element || document.getElementById(sourceID);

        const bus = window.noodleman;
        if (bus == null) throw new Error("CameraWall needs /js/noodleman.js loaded first");

        this.storyID = options.storyid != null ? options.storyid : bus.storyID;

        // Fixed mode: a layout given directly, no story needed.
        this.fixedLayout = options.layout != null && options.layout !== "" ? String(options.layout) : null;

        // Where LookyLooky is. Empty = this page's own origin.
        this.apiBase = String(options.api || "").replace(/\/+$/, "");

        // Defaults matched to view.html so a pane behaves the same on either
        // page; /api/info overrides both when it answers.
        this.bufferMs = 150;

        this.pollMs = options.poll != null ? parseInt(options.poll) : 5000;

        this.grid = null;
        this.cameras = [];
        this.layoutID = "";

        // Which of the six is in the main pane. Held as a camera id, not a
        // slot, so it survives the layout being edited on the camera service
        // under a running game.
        this.selectedID = null;

        // The objective in play as this wall last heard of it, keyed by story,
        // and a camera it asked for before the wall could show it. See
        // FollowObjective.
        this.objectiveKey = null;
        this.pendingCameraID = null;
        this.pendingStoryID = null;

        // Audio follows the main pane. Off to begin with, and remembered per
        // browser: a game master who unmuted a room yesterday wants it unmuted
        // today, and one who did not must never have a screen start talking at
        // them because somebody else did.
        this.muted = this.RestoreMuted();
        // An `audio` option (wall.html passes ?audio=) wins for this page
        // load without changing what is remembered: "none"/"off" starts
        // muted, anything else ("first", "all", "on", a camera id) unmuted.
        // The main pane is the only one with sound, so "all" means it too.
        if (options.audio === "none" || options.audio === "off") this.muted = true;
        else if (options.audio) this.muted = false;

        this.cameraTimer = null;
        this.layoutTimer = null;
        this.building = false;

        noodleman.Subscribe("story-set", (m) => {
            this.storyID = m.value;
            this.Build();
        });

        noodleman.Subscribe("story-id", (m) => {
            this.storyID = m.value;
            this.Build();
        });

        // A story's layout is chosen on its General tab, so a story update can
        // change which wall this is.
        noodleman.Subscribe("story", (m) => {
            this.Build();
        });

        // CamerasEnabled lives in settings, and settings normally land after
        // the first paint.
        noodleman.Subscribe("settings", (m) => {
            if (m.value != null && typeof m.value === "object") noodleman.settings = m.value;
            this.Build();
        });

        // Which objective is in play is the page's call -- the GM screen marks
        // it for Focus -- and the wall only follows. See FollowObjective.
        noodleman.Subscribe("current-objective", (m) => {
            this.FollowObjective(m.value);
        });

        // Fixed-mode controls, for hosts that are not story-driven.
        noodleman.Subscribe("select-camera", (m) => {
            const id = m.value != null && typeof m.value === "object" ? m.value.cameraId : m.value;
            if (id != null && id !== "") this.Select(String(id));
        });

        noodleman.Subscribe("wall-layout", (m) => {
            const l = m.value != null && typeof m.value === "object" ? m.value.layout : m.value;
            if (l == null || l === "") return;
            this.fixedLayout = String(l);
            this.Build();
        });

        // Bound before the first Build, on an element that outlives every
        // rebuild of the wall inside it.
        this.WatchForSelection(this.Parent);

        // Broadcasts are not replayed, and this widget can load after the page
        // has already marked the objective in play, so ask for it again.
        noodleman.Broadcast({ topic: "current-objective-request", value: null, relay: true });

        this.Build();
    }

    /* --- Configuration ---------------------------------------------------- */

    Available() {
        const s = noodleman.settings;
        return s == null || s.CamerasEnabled !== false;
    }

    /** The host's stories, as noodleman carries them (window.stories for older hosts). */
    Stories() {
        return noodleman.stories || window.stories || {};
    }

    /**
     * The camera stream socket, at the /cameras/stream path LookyLooky serves
     * it on: this page's host, or the `api` origin when one was given.
     */
    SocketUrl() {
        if (this.apiBase !== "") {
            const u = new URL(this.apiBase);
            return (u.protocol === "https:" ? "wss:" : "ws:") + "//" + u.host + "/cameras/stream";
        }
        return (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + "/cameras/stream";
    }

    LayoutID() {
        if (this.fixedLayout != null) return this.fixedLayout;

        const s = this.Stories()[this.storyID];
        if (s == null || s.Options == null || s.Options.CameraLayoutID == null)
            return "";

        return s.Options.CameraLayoutID;
    }

    async Json(path) {
        const res = await fetch(this.apiBase + path);
        if (!res.ok)
            throw new Error(res.status + ": " + res.statusText);
        return res.json();
    }

    /* --- Messages ---------------------------------------------------------

       A named blank rather than an empty pane. Whoever is looking at it should
       be told what to go and fix; a black rectangle tells them nothing.
       ----------------------------------------------------------------------- */

    Message(title, detail, actionUrl, actionText) {
        this.Teardown();

        // Only an http(s) address becomes a link. The url is built from an operator-entered
        // setting, and this keeps a javascript: value from being made clickable here.
        const action = (actionUrl && /^https?:\/\//i.test(actionUrl))
            ? "<a class='claudifer-wall-action' href='" + this.Escape(actionUrl) + "' "
            + "target='_blank' rel='noopener'>" + this.Escape(actionText) + "</a>"
            : "";

        SetHtml(this.Parent,
            "<div class='claudifer-wall claudifer-wall-message'><div class='box'>"
          + "<h1>" + this.Escape(title) + "</h1>"
          + (detail ? "<p>" + this.Escape(detail) + "</p>" : "")
          + action
          + "</div></div>");
    }

    Escape(v) {
        return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        }[c]));
    }

    /* --- Build ------------------------------------------------------------- */

    async Build() {
        // Story and settings updates arrive in bursts, and a rebuild is an
        // await chain -- without this two of them interleave and the second
        // grid is built into a container the first is still filling.
        if (this.building) return;

        if (this.Parent == null) return;

        if (!this.Available()) {
            this.Message("Cameras are switched off",
                "Cameras are not enabled for this venue (CamerasEnabled in the host's settings).");
            return;
        }

        if (this.fixedLayout == null && this.Stories()[this.storyID] == null) {
            this.Message("No story selected");
            return;
        }

        // WebCodecs is unavailable outside a secure context. The wall still
        // builds, thumbnail-only, and says so — see Start().
        this.fullMotion = webCodecsAvailable();

        const layoutID = this.LayoutID();

        if (layoutID === "") {
            this.Message("No camera layout chosen for this story",
                "Pick one on the story's General tab, or open the wall with ?layout=<id or name>.");
            return;
        }

        // Already showing this wall. Rebuilding would tear every pane down and
        // make each camera reconnect, and this runs on every story update.
        if (this.grid != null && this.layoutID === layoutID) {
            // A story sharing this layout keeps the panes, but may have brought
            // an objective whose camera was waiting for the wall to catch up.
            this.ApplyPendingCamera();
            return;
        }

        this.building = true;

        try {
            await this.Start(layoutID);
        } catch (err) {
            console.log(this.Name + ".Build: " + err.message);
            this.Message("Could not start the camera wall", err.message);
        } finally {
            this.building = false;
        }
    }

    async Start(layoutID) {
        let layouts = [];
        try {
            layouts = (await this.Json("/api/layouts")).layouts || [];
        } catch (err) {
            this.Message("Could not load camera layouts", err.message);
            return;
        }

        const layout = this.ResolveLayout(layouts, layoutID);
        if (layout == null) {
            this.Message("No such camera layout",
                "No camera layout matches “" + layoutID + "”. "
              + (this.fixedLayout != null ? "Check the layout id or name in the URL." : "Pick another on the story's General tab."));
            return;
        }

        // Match the camera server's playout buffer and decode budget so a pane
        // behaves the same here as on its own board.
        // Only the playout buffer is taken from the service. Its
        // maxFullMotionPanes is advice for a board of equal panes; this board
        // has one pane that matters and six thumbnails, and pins the budget to
        // 1 below regardless.
        try {
            const info = await this.Json("/api/info");
            if (typeof info?.webcodecs?.bufferMs === "number")
                this.bufferMs = info.webcodecs.bufferMs;
            this.qualityPolicy = info?.webcodecs?.qualityPolicy || "sub";
            this.mainMinWidth = info?.webcodecs?.mainMinWidth || 1280;
        } catch (err) { /* keep the default */ }

        try {
            this.cameras = (await this.Json("/api/cameras")).cameras || [];
        } catch (err) {
            this.Message("Could not load cameras", err.message);
            return;
        }

        this.Teardown();

        // Two elements on purpose. CameraGrid reassigns its container's
        // className on every setLayout() -- `grid layout-<type>` -- so the
        // scope class the ported stylesheet needs cannot live on the container
        // itself. It goes on the wrapper, where nothing overwrites it.
        SetHtml(this.Parent, "<div class='claudifer-wall'><div class='grid'></div></div>");

        const container = this.Parent.querySelector(".grid");

        this.grid = new CameraGrid({
            container: container,
            wsUrl: this.SocketUrl(),
            bufferMs: this.bufferMs,

            // One. The main pane is the only one that decodes video; the six
            // previews are MJPEG thumbnails.
            //
            // The grid hands the budget out by rendered area, so the biggest
            // pane wins it -- which is the main one, by construction. That is
            // the whole reason this wall can show seven cameras at all: seven
            // concurrent WebCodecs decoders is what /api/info's budget exists
            // to prevent, and it is the failure the camera service's own notes
            // describe (Chrome ships no software HEVC fallback, and concurrent
            // HEVC decoders were observed emitting green frames).
            maxFullMotionPanes: 1,

            // false in a browser without WebCodecs: every pane a thumbnail.
            fullMotion: this.fullMotion !== false,

            qualityPolicy: this.qualityPolicy || "sub",
            mainMinWidth: this.mainMinWidth || 1280,

            interactive: false,

            // 7f with a slot for every preview: CameraGrid builds only
            // def.slots panes, and the stock 7f stops at six previews.
            layoutDefs: Object.assign({}, CameraGrid.defaultLayoutDefs(), {
                "7f": { cols: 3, rows: 4, slots: 1 + CameraWall.PREVIEW_PANES, featured: 0 },
            }),
        });

        if (this.fullMotion === false && window.LookyCompat != null && !this._bannered) {
            this._bannered = true;
            window.LookyCompat.insecureBanner(window.LookyCompat.securePort || "");
        }

        // Hover controls, drag and double-click stay off, as on view.html.
        // Selection is handled by this widget instead -- see
        // WatchForSelection, bound once in the constructor.
        this.grid.buildEmptySlot = (i) => this.BuildEmptySlot(i);

        // The speaker on the main pane switched off = the wall's mute button.
        this.grid.onFocalMuteRequest = () => { if (!this.muted) this.ToggleMuted(); };

        // options.quality: "high" / "low" pins the whole wall.
        const q = String(this.options.quality || "").toLowerCase();
        if (q === "high" || q === "main") this.grid.setQualityOverride("main");
        else if (q === "low" || q === "sub") this.grid.setQualityOverride("sub");

        const shaped = this.ShapeLayout(layout);

        this.grid.setLayout(shaped, this.cameras);
        this.ApplyWallRows();
        this.BuildAudioControl();
        this.ApplyAudio();

        this.layoutID = layoutID;

        // The raw layout, not the shaped one: the poll below compares against
        // what the service last sent, and shaping is not reversible.
        this._layout = layout;

        // ShapeLayout seated the objective's camera if this wall has a pane for
        // it. Either way it has had its chance.
        if (String(this.pendingStoryID) === String(this.storyID))
            this.pendingCameraID = null;

        this.StartPolling(layoutID);
    }

    /**
     * The wall this screen shows is always the same shape, whatever shape the
     * layout was saved as on the camera service: one main pane across the top
     * with a 16:9 box of its own, and up to six below it in two rows of three.
     *
     * That is the camera service's own '7f' grid type, so this re-labels the
     * layout rather than inventing one -- CameraGrid, its CSS and its featured
     * -pane logic all already understand it. The 16:9 on the main pane is the
     * one thing added on top, in camera-wall.css.
     *
     * Capping happens HERE, on the data, not in CSS. Hiding the eighth pane
     * with display:none would still have built it: a WebSocket, a VideoDecoder
     * and an AudioDecoder per hidden camera, all running and all invisible. A
     * layout saved as 13f on the service costs seven streams here, not
     * thirteen.
     *
     * Slots are re-indexed rather than filtered in place. A service layout can
     * have gaps -- slot 0 empty, slot 4 assigned -- and 7f reads slots 0..6 in
     * order, so leaving the holes would drop real cameras off the end.
     */
    /**
     * The cameras of this layout, in slot order, up to PREVIEW_PANES.
     *
     * Ids, not panes. The camera service's layout can have gaps -- slot 0
     * empty, slot 4 assigned -- so this reads slots in numeric order and takes
     * the assigned ones, which is what makes "camera 1 through 6" mean the
     * order the author arranged them in rather than the order the object
     * happens to enumerate.
     */
    PreviewCameras(layout) {
        const source = (layout && layout.slots) || {};
        const ids = [];

        const keys = Object.keys(source)
            .map(Number)
            .filter((n) => !isNaN(n))
            .sort((a, b) => a - b);

        for (const key of keys) {
            const slot = source[String(key)];
            if (slot == null || slot.cameraId == null || slot.cameraId === "") continue;

            ids.push(slot.cameraId);
            if (ids.length >= CameraWall.PREVIEW_PANES) break;
        }

        return ids;
    }

    /**
     * The wall this screen shows is always the same shape, whatever shape the
     * layout was saved as on the camera service: one main pane across the top
     * and up to six previews below it, in the author's order.
     *
     * The main pane is not a seventh camera. It is a VIEW onto one of the six,
     * and clicking a preview changes which. So the selected camera appears
     * once, at the top, and the preview it came from is left unassigned --
     * BuildEmptySlot() draws "VIEWING" there instead.
     *
     * That is forced as much as chosen: CameraGrid keys its pane map by camera
     * id, so the same camera in two slots collapses to one pane and the second
     * slot renders empty anyway. A placeholder that says why is better than a
     * hole that does not.
     *
     * Capping happens HERE, on the data, not in CSS. Hiding a pane with
     * display:none would still have built it: a WebSocket and a decoder per
     * hidden camera, running and invisible.
     *
     * The grid type is the camera service's own '7f', so CameraGrid, its CSS
     * and its featured-pane logic all already understand the shape.
     */
    ShapeLayout(layout) {
        if (layout == null) return layout;

        const previews = this.PreviewCameras(layout);

        // A camera the objective in play asked for before this wall was up.
        if (this.pendingCameraID != null
            && String(this.pendingStoryID) === String(this.storyID)
            && previews.indexOf(this.pendingCameraID) !== -1)
            this.selectedID = this.pendingCameraID;

        // Nothing selected yet, or the selection has gone from the layout:
        // fall back to the first, so the main pane always has something.
        if (previews.indexOf(this.selectedID) === -1)
            this.selectedID = previews.length > 0 ? previews[0] : null;

        const slots = {};

        if (this.selectedID != null)
            slots["0"] = { cameraId: this.selectedID };

        for (var i = 0; i < previews.length; i++) {
            // The selected camera's own preview is deliberately left out.
            if (previews[i] === this.selectedID) continue;

            slots[String(i + 1)] = { cameraId: previews[i] };
        }

        // Where the hole is, so BuildEmptySlot knows which one to label; how
        // many previews there are, which decides the row count; and the order
        // itself, which Select() rearranges the panes into.
        this.viewingSlot  = previews.indexOf(this.selectedID) + 1;
        this.previewCount = previews.length;
        this.previews     = previews;

        return Object.assign({}, layout, { gridType: "7f", slots: slots });
    }

    /**
     * The preview the selected camera would have occupied. Everything else
     * empty stays empty -- a layout with four cameras should show two blanks,
     * not two labels.
     */
    BuildEmptySlot(slotIndex) {
        if (slotIndex !== this.viewingSlot) return "";

        // A one-camera room is one pane. Labeling the only preview "VIEWING"
        // under a main pane showing the same thing says nothing, and costs a
        // whole row to say it.
        if (this.previewCount <= 1) return "";

        return '<div class="camera-card claudifer-viewing">'
             +   '<div class="claudifer-viewing-label">VIEWING</div>'
             + '</div>';
    }

    /* --- Audio --------------------------------------------------------------

       Only one pane carries sound, and it is the main one. CameraGrid calls
       that the focal stream: setFocusedCamera() moves the audio graph onto a
       camera and mutes whichever had it before, so there is never more than
       one room audible at a time.

       Its _audio state starts { focal: null, muted: true }, which is why the
       wall was silent -- nothing had ever claimed the focus. This claims it
       for the selected camera on every build and every selection.

       Focus also pins that pane to full motion in the grid's re-rank, which
       matters here: audio lives on the WebCodecs client, and a pane demoted to
       an MJPEG thumbnail has no audio graph at all. The main pane is the
       biggest and would win the budget anyway; this makes it certain.
       ----------------------------------------------------------------------- */

    ApplyAudio() {
        const grid = this.grid;
        if (grid == null || this.selectedID == null) return;

        /* Deliberately NOT grid.setFocusedCamera().

           That method does two things: it moves the audio, and then it calls
           _applyTempFocus() -- the grid's own display-only DOM swap, which
           lifts the focused camera into the featured slot by moving pane
           elements around.

           This wall already decides where its panes go (see Select). Two
           mechanisms rearranging the same nodes do not compose: the grid's
           swap works from stored slot indices, which stop matching the DOM the
           moment Select has moved anything, so it lands on the wrong children
           and the main pane ends up showing the VIEWING blank.

           So this does the audio half by hand and leaves the DOM alone. It
           reaches into _audio and _panes to do it -- the same privates
           Teardown already uses -- because the public method cannot be asked
           for one half without the other.

           Volume stays at 1: the toggle is mute/unmute, and a level control
           belongs with the venue's own sound levels, not on a camera pane. */
        const previous = grid._audio == null ? null : grid._audio.focal;

        grid._audio = { focal: this.selectedID, volume: 1, muted: this.muted };

        if (grid._panes != null) {
            // Silence whatever had the sound before, then hand it over.
            if (previous != null && previous !== this.selectedID)
                grid._panes.get(previous)?.setFocalStream(false);

            grid._panes.get(this.selectedID)?.setFocalStream(true, 1, this.muted);
        }

        // The focal pane is pinned full-motion by the re-rank, which is what
        // keeps it decoding -- a pane demoted to a thumbnail has no audio
        // graph at all.
        if (typeof grid._rerank === "function") grid._rerank();
        if (typeof grid.syncSoundPrompt === "function") grid.syncSoundPrompt();

        const btn = this.Parent == null ? null : this.Parent.querySelector(".claudifer-mute");
        if (btn == null) return;

        btn.classList.toggle("active", !this.muted);
        btn.setAttribute("title", this.muted ? "Unmute this camera" : "Mute this camera");
        btn.innerHTML = this.muted ? CameraWall.ICON_MUTED : CameraWall.ICON_SOUND;
    }

    ToggleMuted() {
        this.muted = !this.muted;

        // Muting the wall silences everything, pane speakers included.
        if (this.muted && this.grid != null) this.grid.clearPaneAudio();

        try { localStorage.setItem("claudifer-wall-muted", this.muted ? "1" : "0"); }
        catch (err) { /* private window, or storage off */ }

        this.ApplyAudio();
    }

    RestoreMuted() {
        try { return localStorage.getItem("claudifer-wall-muted") !== "0"; }
        catch (err) { return true; }
    }

    /**
     * The toggle, in the main pane's corner.
     *
     * A sibling of the grid rather than something inside a pane. CameraGrid
     * owns every pane's markup and rebuilds it on a status change or a tier
     * switch, so a button placed in there would come and go; and the main pane
     * spans the full width of the top row, which makes the wall's own top-right
     * corner the same corner. It survives every render this way, and needs
     * binding only once.
     */
    BuildAudioControl() {
        if (this.Parent == null) return;

        const wall = this.Parent.querySelector(".claudifer-wall");
        if (wall == null || wall.querySelector(".claudifer-mute") != null) return;

        const holder = document.createElement("div");
        holder.className = "audio-control claudifer-audio";
        holder.innerHTML = '<button type="button" class="audio-mute-btn claudifer-mute"></button>';

        holder.querySelector(".claudifer-mute").addEventListener("click", (e) => {
            // The selection listener already ignores this -- the button is a
            // sibling of the grid, so closest('.camera-card') finds nothing --
            // but it sits ON the main pane, and anyone moving it later would
            // reasonably expect the click not to also change the selection.
            e.stopPropagation();
            this.ToggleMuted();
        });

        wall.appendChild(holder);
    }

    /**
     * Tell the stylesheet how many rows of three sit under the main pane, so a
     * room with two cameras is not one pane over an empty half.
     *
     * The previews decide this, not the slot count. The slot map also holds
     * the main pane, and is one short where the selected camera's own preview
     * was left out, so counting it would be wrong in two directions at once.
     *
     * Written on the WALL rather than the grid, and as a data attribute rather
     * than a class.
     *
     * On the wall, because two things need the row count: the grid, to shape
     * its rows, and the mute control, to sit on the picture's own edge rather
     * than the pane's. The stylesheet turns this into the wall's aspect ratio
     * as a custom property, which inherits down to both -- the grid is the
     * control's sibling, and custom properties do not travel sideways.
     *
     * As an attribute, because CameraGrid reassigns the grid's className on
     * every setLayout(). That no longer reaches this now it lives a level up,
     * but it is still re-applied after each setLayout, because the layout is
     * what changes the preview count in the first place.
     */
    ApplyWallRows() {
        if (this.Parent == null) return;

        const wall = this.Parent.querySelector(".claudifer-wall");
        if (wall == null) return;

        const previews = this.previewCount || 0;
        const perRow = CameraWall.PerRow(previews);

        const rows = previews <= 1 ? 0 : Math.ceil(previews / perRow);

        // An upright phone or tablet: two across for up to six, three past that.
        const perRowNarrow = perRow - 1;
        // Same fixed grid as the wide one, re-flowed: a pane keeps its size
        // whether the room fills every slot or not.
        const rowsNarrow = Math.ceil(rows * perRow / perRowNarrow);

        wall.setAttribute("data-rows", String(rows));
        wall.style.setProperty("--wall-cols", String(perRow));
        wall.style.setProperty("--wall-rows", String(rows));
        wall.style.setProperty("--wall-cols2", String(perRowNarrow));
        wall.style.setProperty("--wall-rows2", String(rowsNarrow));
    }

    /**
     * Clicking a preview puts it in the main pane.
     *
     * Bound ONCE, in the constructor, to the widget's own element -- not to
     * the grid container inside it. That container is created fresh by every
     * Start(), and CameraGrid replaces its whole contents on every render, so
     * a listener attached there is either missed or duplicated depending on
     * how the wall was last rebuilt. The widget's element outlives all of it.
     *
     * Delegated rather than routed through CameraGrid's own
     * onPaneFocusRequest, because that hook is only wired when the grid is
     * built interactive:true -- and interactive also makes every pane
     * draggable and binds drag, drop and double-click handlers this board has
     * no use for.
     */
    WatchForSelection(host) {
        if (host == null) return;

        host.addEventListener("click", (e) => {
            if (this.grid == null) return;

            const card = e.target.closest(".camera-card");
            if (card == null || card.id === "") return;

            // CameraPane ids are `<prefix>card-<cameraId>`; the wall sets no
            // prefix. The VIEWING placeholder carries no id, so clicking what
            // is already on screen does nothing.
            const id = card.id.replace(/^card-/, "");
            if (id === card.id || id === this.selectedID) return;

            this.Select(id);
        });
    }

    /**
     * Move the chosen camera into the main pane.
     *
     * By rearranging the panes that are already on screen -- NOT by handing
     * CameraGrid a new layout. setLayout() goes through _render(), which
     * destroys every pane and builds them again: seven WebSockets closed and
     * reopened, a decoder torn down and recreated, and the whole wall blank
     * for as long as that takes. For an action a game master takes a dozen
     * times a game, that is the wrong price.
     *
     * appendChild on an element that is already in the document MOVES it. The
     * pane objects, their sockets, their decoders and their canvas contents
     * all survive -- only their position changes. Rebuilding the child order
     * from scratch each time, rather than swapping pairs, keeps this correct
     * however many times it runs and whatever was selected before.
     *
     * The one thing that does change tier is the decode budget: the main pane
     * is the only full-motion stream, so _rerank() promotes the newcomer and
     * demotes the outgoing one. That is a setMode() on two panes -- a
     * transition the grid is built for -- not a rebuild.
     */
    Select(cameraID) {
        if (this.grid == null || cameraID === this.selectedID) return;
        if (this.previews == null || this.previews.indexOf(cameraID) === -1) return;

        const grid = this.Parent == null ? null : this.Parent.querySelector(".grid");
        if (grid == null) return;

        // The panes on screen, by the camera each one is showing, plus the
        // VIEWING blank. Read from the DOM rather than from the grid's own map
        // so this works on exactly what is there.
        const panes = {};
        var blank = null;

        Array.prototype.forEach.call(grid.children, (el) => {
            if (el.id != null && el.id.indexOf("card-") === 0)
                panes[el.id.slice("card-".length)] = el;
            else if (el.className.indexOf("claudifer-viewing") !== -1)
                blank = el;
        });

        const chosen = panes[cameraID];
        if (chosen == null) return;                 // camera has no pane to move

        this.selectedID   = cameraID;
        this.viewingSlot  = this.previews.indexOf(cameraID) + 1;

        // Main pane first, then the previews in the author's order, with the
        // blank standing in for whichever one is now upstairs.
        const order = [chosen];

        for (var i = 0; i < this.previews.length; i++) {
            const id = this.previews[i];

            if (id === cameraID) {
                if (blank != null) order.push(blank);
                continue;
            }

            if (panes[id] != null) order.push(panes[id]);
        }

        // Every pane that moves starts unzoomed in its new place.
        order.forEach((el, i) => {
            if (grid.children[i] !== el) {
                const id = el.id && el.id.indexOf("card-") === 0 ? el.id.slice("card-".length) : null;
                if (id != null) this.grid.resetZoom(id);
            }
        });
        order.forEach((el) => grid.appendChild(el));

        // Hand the full-motion budget to whatever is now the biggest pane.
        if (typeof this.grid._rerank === "function") this.grid._rerank();

        // ...and the sound with it. ApplyAudio silences the pane that had it
        // before handing it over, so this is also what stops the previous
        // camera being heard.
        this.ApplyAudio();
    }

    /**
     * Put the objective in play's camera in the main pane -- once, when that
     * objective comes into play.
     *
     * The page sends the objective every time it marks one, which is every
     * render of the objective list, not just a change. Only a DIFFERENT
     * objective moves the pane: a game master who clicked another camera has
     * it stay up across all those re-marks, until the game moves on to the
     * next objective. An objective that names no camera leaves the wall
     * showing whatever it is showing.
     *
     * Keyed by story as well as objective, because objective ids are only
     * unique within one story and switching rooms is itself a change.
     */
    FollowObjective(value) {
        if (value == null) return;

        const o = value.Objective;
        const key = String(value.StoryID) + ":" + (o == null ? "" : String(o.ID));

        if (key === this.objectiveKey) return;
        this.objectiveKey = key;

        this.pendingCameraID = null;

        const cameraID = (o != null && o.CameraID != null && o.CameraID !== "") ? String(o.CameraID) : null;
        if (cameraID == null) return;

        // Up and showing this story's layout: move the pane now. Select ignores
        // a camera the wall has no pane for -- one past the twelve previews, or one
        // the layout has since lost.
        const ready = this.grid != null && !this.building
                   && String(value.StoryID) === String(this.storyID)
                   && this.layoutID === this.LayoutID();

        if (ready) {
            this.Select(cameraID);
            return;
        }

        // Otherwise the wall is on its way: the page marks the new story's
        // objective from its own story-set handler, which runs before this
        // widget's has even heard the story changed. Start() or Build() seats
        // the camera once the wall has caught up.
        this.pendingCameraID = cameraID;
        this.pendingStoryID = value.StoryID;
    }

    /** A camera FollowObjective could not put up yet, on a wall that now can. */
    ApplyPendingCamera() {
        const id = this.pendingCameraID;
        if (id == null || String(this.pendingStoryID) !== String(this.storyID)) return;

        this.pendingCameraID = null;
        this.Select(id);
    }

    /**
     * Accepts an id or a name, matched case-insensitively -- the same rule
     * view.html uses, so a layout referenced either way resolves the same on
     * both pages.
     */
    ResolveLayout(layouts, want) {
        if (!want) return null;

        const key = String(want).trim().toLowerCase();

        return layouts.find(l => String(l.id).toLowerCase() === key)
            || layouts.find(l => String(l.name).toLowerCase() === key)
            || null;
    }

    /* --- Polling -----------------------------------------------------------

       Camera status every 5s; layout edits at half that rate. Both are the
       camera server's own cadence from view.html. The layout poll is what
       picks up a slot being re-assigned on its dashboard without anyone
       reloading this screen.
       ----------------------------------------------------------------------- */

    StartPolling(layoutID) {
        this.StopPolling();

        this.cameraTimer = setInterval(async () => {
            try {
                const data = await this.Json("/api/cameras");
                this.cameras = data.cameras || data;
                this.grid.update(this.cameras);
            } catch (err) { /* transient -- the next poll retries */ }
        }, this.pollMs);

        this.layoutTimer = setInterval(async () => {
            try {
                const layouts = (await this.Json("/api/layouts")).layouts || [];
                const fresh = this.ResolveLayout(layouts, layoutID);

                if (fresh && JSON.stringify(fresh) !== JSON.stringify(this._layout)) {
                    this._layout = fresh;

                    const reshaped = this.ShapeLayout(fresh);
                    this.grid.setLayout(reshaped, this.cameras);
                    this.ApplyWallRows();

                    // setLayout rebuilds the panes, and the focal stream goes
                    // with them.
                    this.ApplyAudio();
                }
            } catch (err) { /* transient */ }
        }, this.pollMs * 2);
    }

    StopPolling() {
        if (this.cameraTimer != null) clearInterval(this.cameraTimer);
        if (this.layoutTimer != null) clearInterval(this.layoutTimer);

        this.cameraTimer = null;
        this.layoutTimer = null;
    }

    /* --- Lifecycle --------------------------------------------------------- */

    /**
     * CameraGrid has no destroy() of its own -- on the camera server it is
     * built once and lives for the life of the page, so it never needed one.
     * Here the wall is rebuilt whenever the story changes, and everything the
     * constructor attaches would otherwise accumulate: two document-level
     * listeners and a ResizeObserver per rebuild, plus a WebSocket and a
     * decoder per pane, all still running against a container that is no
     * longer on the screen.
     *
     * So this unwinds the constructor by hand. It reaches into privates to do
     * it, which is the wrong shape long-term -- the fix belongs upstream as a
     * CameraGrid.destroy(), and this should call that the moment it exists.
     * Written defensively so it stays harmless if the internals are renamed.
     */
    Teardown() {
        this.StopPolling();

        const grid = this.grid;

        if (grid != null) {
            try {
                if (typeof grid.destroy === "function") {
                    grid.destroy();                     // preferred, once upstream has one
                } else {
                    if (grid._panes != null) {
                        grid._panes.forEach(p => { try { p.destroy(); } catch (err) { } });
                        grid._panes.clear();
                    }

                    if (grid._visibilityHandler != null)
                        document.removeEventListener("visibilitychange", grid._visibilityHandler);

                    if (grid._fullscreenRerank != null)
                        document.removeEventListener("fullscreenchange", grid._fullscreenRerank);

                    if (grid._resizeObserver != null)
                        grid._resizeObserver.disconnect();

                    if (grid._resizeDebounce != null)
                        clearTimeout(grid._resizeDebounce);
                }
            } catch (err) {
                console.log(this.Name + ".Teardown: " + err.message);
            }
        }

        this.grid = null;
        this.layoutID = "";
        this._layout = null;
    }

    Reset() {
        // Nothing to reset between games -- the wall is a property of the room,
        // not of the session.
    }

    Resize() {
        // Nothing to do. CameraGrid puts a debounced ResizeObserver on its own
        // container in the constructor, so it re-ranks the decode budget and
        // re-picks pane variants off its own back -- calling anything here
        // would only duplicate that work.
    }

    Dispose() {
        this.Teardown();
    }
}
