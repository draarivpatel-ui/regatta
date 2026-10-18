// Electron main used only to rasterize scripts/icon/icon-page.html to a PNG.
// It opens one hidden 1024 by 1024 frameless window. scripts/icon/render.mjs drives it with Playwright,
// captures the page, and closes the app. Run it through render.mjs, not on its own.

const { app, BrowserWindow } = require('electron')
const path = require('node:path')

app.commandLine.appendSwitch('force-color-profile', 'srgb')

function createIconWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    resizable: false,
    show: false,
    transparent: true,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  void win.loadFile(path.join(__dirname, 'icon-page.html'))
}

app.whenReady().then(createIconWindow)
