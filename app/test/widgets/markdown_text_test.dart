import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/widgets/markdown_text.dart';

/// These validate the `flutter_markdown_plus` (+ `_latex`) integration in
/// [MarkdownText]: that the common chat constructs render, and — critically for
/// streaming agent output — that partial/malformed markdown never throws.
Future<void> _pump(WidgetTester tester, String text) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: MarkdownText(text))));
  await tester.pump();
}

void main() {
  testWidgets('plain text renders as-is', (tester) async {
    await _pump(tester, 'hello there');
    expect(find.textContaining('hello there'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('bold / italic / inline code render without error', (tester) async {
    await _pump(tester, '**bold** and *italic* and `code` and ~~gone~~');
    expect(find.textContaining('bold'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a fenced code block renders (content + language)', (tester) async {
    await _pump(tester, 'before\n\n```dart\nvoid main() {}\n```\n\nafter');
    expect(find.textContaining('void main'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a bullet list renders its items', (tester) async {
    await _pump(tester, '- one\n- two\n- three');
    expect(find.textContaining('one'), findsWidgets);
    expect(find.textContaining('three'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a link renders its text', (tester) async {
    await _pump(tester, 'see [the docs](https://example.test/docs) now');
    expect(find.textContaining('the docs'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('inline + block LaTeX math renders without throwing', (tester) async {
    await _pump(tester, r'Euler: $e^{i\pi}+1=0$' '\n\n' r'$$\int_0^1 x^2\,dx$$');
    // The latex builder produces Math widgets; the key assertion is no throw.
    expect(tester.takeException(), isNull);
  });

  testWidgets('a GFM table renders', (tester) async {
    await _pump(tester, '| a | b |\n|---|---|\n| 1 | 2 |');
    expect(find.textContaining('a'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('partial/streaming markdown never throws', (tester) async {
    // An unterminated code fence, a lone emphasis marker, a half-written link,
    // an open math delimiter, an unfinished table — all the shapes a message
    // passes through while an agent streams it token by token.
    for (final partial in <String>[
      '```dart\nvoid main() {',
      'this is *incomplete',
      'a [half link](http',
      r'math $e^{i\pi',
      '| a | b',
      '### ',
      '',
      '> quote without end',
    ]) {
      await _pump(tester, partial);
      expect(tester.takeException(), isNull, reason: 'threw on: ${partial.substring(0, partial.length.clamp(0, 20))}');
    }
  });
}
