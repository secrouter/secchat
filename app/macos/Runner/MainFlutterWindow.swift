import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    self.contentViewController = flutterViewController

    // The storyboard opens the window tiny; give it a comfortable default so the chat layout has
    // room, centered on screen, with a sensible minimum so it can't be dragged down to a sliver.
    self.setContentSize(NSSize(width: 1200, height: 820))
    self.minSize = NSSize(width: 940, height: 640)
    self.center()

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
