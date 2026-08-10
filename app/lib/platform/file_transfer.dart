/// Picking files to upload + saving downloaded bytes — browser-native on web,
/// no-ops elsewhere (see the "web now, desktop/mobile later" note in pubspec.yaml).
/// Conditionally exports the web implementation vs. the stub so the shared call
/// sites (composer, chat screen) compile and analyze on every target.
library;

export 'file_transfer_api.dart';
export 'file_transfer_stub.dart' if (dart.library.js_interop) 'file_transfer_web.dart';
