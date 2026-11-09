import { BrowserWindow, screen } from 'electron';

/** A click-through native window: it remains visible above apps, not just inside the browser DOM. */
export class DesktopPointer {
  private window: BrowserWindow;
  private tracking: ReturnType<typeof setInterval> | undefined;
  constructor() {
    this.window = new BrowserWindow({
      width: 52,
      height: 52,
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    void this.window.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<html><body style="margin:0;overflow:hidden;background:transparent"><div id="dot" style="position:absolute;left:14px;top:14px;width:20px;height:20px;border:2px solid white;border-radius:50%;background:#30b5d5aa;box-shadow:0 0 0 7px #30b5d544"></div></body></html>`,
        ),
    );
  }
  async show(point: { x: number; y: number; clicking: boolean }, follow = false): Promise<void> {
    this.stopTracking();
    if (this.window.isDestroyed()) return;
    this.window.setPosition(Math.round(point.x - 26), Math.round(point.y - 26));
    await this.window.webContents.executeJavaScript(
      `document.getElementById('dot').style.background=${JSON.stringify(point.clicking ? '#fb923ccc' : '#30b5d5aa')}`,
    );
    this.window.showInactive();
    if (follow)
      this.tracking = setInterval(() => {
        if (this.window.isDestroyed()) return;
        const cursor = screen.getCursorScreenPoint();
        this.window.setPosition(cursor.x - 26, cursor.y - 26);
      }, 33);
  }
  private stopTracking() {
    if (this.tracking) clearInterval(this.tracking);
    this.tracking = undefined;
  }
  hide() {
    this.stopTracking();
    if (!this.window.isDestroyed()) this.window.hide();
  }
  close() {
    this.stopTracking();
    if (!this.window.isDestroyed()) this.window.close();
  }
}
