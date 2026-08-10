import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'file_transfer_api.dart';

/// Opens the browser's native file picker and reads the chosen files' bytes.
Future<List<PickedFile>> pickFiles() async {
  final input = web.document.createElement('input') as web.HTMLInputElement
    ..type = 'file'
    ..multiple = true;
  final completer = Completer<List<PickedFile>>();
  input.onchange = (web.Event _) {
    final files = input.files;
    if (files == null || files.length == 0) {
      completer.complete(const []);
      return;
    }
    final reads = <Future<PickedFile>>[];
    for (var i = 0; i < files.length; i++) {
      reads.add(_read(files.item(i)!));
    }
    Future.wait(reads).then(completer.complete);
  }.toJS;
  input.click();
  return completer.future;
}

Future<PickedFile> _read(web.File file) async {
  final buffer = await file.arrayBuffer().toDart;
  final bytes = buffer.toDart.asUint8List();
  final type = file.type.isEmpty ? 'application/octet-stream' : file.type;
  return PickedFile(filename: file.name, contentType: type, bytes: bytes);
}

/// Triggers a browser download of [bytes] as [filename].
void saveBytes(String filename, String contentType, List<int> bytes) {
  final data = bytes is Uint8List ? bytes : Uint8List.fromList(bytes);
  final blob = web.Blob([data.toJS].toJS, web.BlobPropertyBag(type: contentType));
  final url = web.URL.createObjectURL(blob);
  final anchor = web.document.createElement('a') as web.HTMLAnchorElement
    ..href = url
    ..download = filename;
  anchor.click();
  web.URL.revokeObjectURL(url);
}
