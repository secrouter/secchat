/// A file the user picked to upload — bytes plus metadata, platform-agnostic so
/// the shared call sites (composer, chat screen) reference one type regardless of
/// which platform implementation is compiled in (see `file_transfer.dart`).
class PickedFile {
  const PickedFile({required this.filename, required this.contentType, required this.bytes});

  final String filename;
  final String contentType;
  final List<int> bytes;
}
