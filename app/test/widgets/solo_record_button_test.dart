import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/widgets/call_button.dart';

import '../calls/fake_call_controller.dart';

void main() {
  // [SoloRecordButton] is what `_callButtonFor` (chat.dart) returns for a
  // self-DM (`channel.kind == ChannelKind.dm && channel.peer(mySub) == null`)
  // instead of the peer-gated [CallButton] -- these tests exercise it exactly
  // as it's used there: keyed to the self-DM's own channelId, no peer at all.
  Widget host(FakeCallController controller) => MaterialApp(
    home: Scaffold(
      body: SoloRecordButton(controller: controller, channelId: 'self-dm-1'),
    ),
  );

  testWidgets('enabled with no peer/presence gating for a self-DM', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));
    final button = tester.widget<PopupMenuButton<bool>>(find.byType(PopupMenuButton<bool>));
    expect(button.enabled, isTrue);
  });

  testWidgets('disabled while a call/memo is already in progress', (tester) async {
    final controller = FakeCallController()
      ..emit(const CallSnapshot(phase: CallPhase.recordingMemo, channelId: 'self-dm-1', amCaller: true));
    await tester.pumpWidget(host(controller));
    final button = tester.widget<PopupMenuButton<bool>>(find.byType(PopupMenuButton<bool>));
    expect(button.enabled, isFalse);
  });

  testWidgets('shows "Record memo" and "Record & save my voiceprint" options', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));

    await tester.tap(find.byType(PopupMenuButton<bool>));
    await tester.pumpAndSettle();

    expect(find.text('Record memo'), findsOneWidget);
    expect(find.text('Record & save my voiceprint'), findsOneWidget);
  });

  testWidgets('tapping "Record memo" starts a solo recording without enroll', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));

    await tester.tap(find.byType(PopupMenuButton<bool>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Record memo'));
    await tester.pumpAndSettle();

    expect(controller.startSoloRecordCalls, [
      (channelId: 'self-dm-1', wantRecording: true, enroll: false),
    ]);
  });

  testWidgets('tapping "Record & save my voiceprint" starts a solo recording with enroll', (
    tester,
  ) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));

    await tester.tap(find.byType(PopupMenuButton<bool>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Record & save my voiceprint'));
    await tester.pumpAndSettle();

    expect(controller.startSoloRecordCalls, [
      (channelId: 'self-dm-1', wantRecording: true, enroll: true),
    ]);
  });
}
