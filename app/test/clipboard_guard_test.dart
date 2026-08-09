import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/clipboard_guard.dart';
import 'package:secchat_app/marking.dart';

/// The clipboard guard's decision brain — level+category dominance applied to a
/// paste, deciding allow / block (marked channel spillage) / raise (propagate the
/// source marking into an unmarked channel). recordCopy touches the (mocked)
/// clipboard, so the flutter_test binding is initialized.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const policy = MarkingPolicy(
    levels: ['UNCLASSIFIED', 'PROPRIETARY', 'CUI'],
    defaultLevel: 'UNCLASSIFIED',
    categories: [
      MarkingCategory(code: 'SP-PRVCY', name: 'Privacy', level: 'CUI'),
      MarkingCategory(code: 'SP-EXPT', name: 'Export Controlled', level: 'CUI'),
    ],
  );

  PasteDecision decide(
    ClipboardGuard g, {
    required String text,
    String? channel,
    String dest = 'UNCLASSIFIED',
  }) =>
      g.decidePaste(pastedText: text, channelMarking: channel, destinationMarking: dest, policy: policy);

  test('an untracked paste (no matching in-app copy) is allowed', () {
    final g = ClipboardGuard();
    expect(decide(g, text: 'anything', channel: 'UNCLASSIFIED').action, PasteGuardAction.allow);
  });

  test('a paste different from the tracked copy is not guarded', () async {
    final g = ClipboardGuard();
    await g.recordCopy('cui secret', 'CUI');
    expect(decide(g, text: 'something else', channel: 'UNCLASSIFIED').action, PasteGuardAction.allow);
  });

  test('baseline content is never guarded', () async {
    final g = ClipboardGuard();
    await g.recordCopy('hello', 'UNCLASSIFIED');
    expect(decide(g, text: 'hello', channel: 'UNCLASSIFIED').action, PasteGuardAction.allow);
  });

  test('a marked channel BLOCKS a source it cannot dominate (higher level)', () async {
    final g = ClipboardGuard();
    await g.recordCopy('secret', 'CUI');
    final d = decide(g, text: 'secret', channel: 'PROPRIETARY');
    expect(d.action, PasteGuardAction.block);
    expect(d.sourceMarking, 'CUI');
  });

  test('a marked channel BLOCKS a source carrying a category it lacks; allows a superset', () async {
    final g = ClipboardGuard();
    await g.recordCopy('pii', 'CUI//SP-PRVCY');
    expect(decide(g, text: 'pii', channel: 'CUI').action, PasteGuardAction.block, reason: 'plain CUI lacks SP-PRVCY');
    expect(decide(g, text: 'pii', channel: 'CUI//SP-PRVCY').action, PasteGuardAction.allow);
  });

  test('an unmarked channel RAISES the marking to match elevated content', () async {
    final g = ClipboardGuard();
    await g.recordCopy('pii', 'CUI//SP-PRVCY');
    final d = decide(g, text: 'pii', channel: null, dest: 'UNCLASSIFIED');
    expect(d.action, PasteGuardAction.raise);
    expect(d.targetMarking, 'CUI//SP-PRVCY');
  });

  test('an unmarked channel allows when the destination already dominates the source', () async {
    final g = ClipboardGuard();
    await g.recordCopy('note', 'PROPRIETARY');
    expect(decide(g, text: 'note', channel: null, dest: 'CUI').action, PasteGuardAction.allow);
  });
}
