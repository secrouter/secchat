import 'file_transfer_api.dart';

/// Non-web fallbacks — there's no browser file dialog / download off the web, so
/// these are no-ops (kept as harmless stubs so `lib/` analyzes and `flutter test`
/// runs on any platform). See `file_transfer.dart` for the conditional export.
Future<List<PickedFile>> pickFiles() async => const [];

void saveBytes(String filename, String contentType, List<int> bytes) {}
