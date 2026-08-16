import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/widgets/call_button.dart';

import '../calls/fake_call_controller.dart';

void main() {
  Widget host(FakeCallController controller, {bool peerOnline = true}) => MaterialApp(
    home: Scaffold(
      body: CallButton(
        controller: controller,
        channelId: 'chan_1',
        peerSub: 'bob',
        peerLabel: 'Bob',
        peerOnline: peerOnline,
      ),
    ),
  );

  testWidgets('disabled when the peer is offline', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller, peerOnline: false));
    final button = tester.widget<PopupMenuButton<bool>>(find.byType(PopupMenuButton<bool>));
    expect(button.enabled, isFalse);
  });

  testWidgets('disabled while a call is already in progress', (tester) async {
    final controller = FakeCallController()
      ..emit(const CallSnapshot(phase: CallPhase.active, channelId: 'chan_2', peerSub: 'carol'));
    await tester.pumpWidget(host(controller));
    final button = tester.widget<PopupMenuButton<bool>>(find.byType(PopupMenuButton<bool>));
    expect(button.enabled, isFalse);
  });

  testWidgets('tapping "Call" starts an unrecorded call', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));

    await tester.tap(find.byType(PopupMenuButton<bool>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Call'));
    await tester.pumpAndSettle();

    expect(controller.startCalls, [(channelId: 'chan_1', peerSub: 'bob', wantRecording: false)]);
  });

  testWidgets('tapping "Call and record" starts a recording-requested call', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));

    await tester.tap(find.byType(PopupMenuButton<bool>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Call and record'));
    await tester.pumpAndSettle();

    expect(controller.startCalls, [(channelId: 'chan_1', peerSub: 'bob', wantRecording: true)]);
  });
}
