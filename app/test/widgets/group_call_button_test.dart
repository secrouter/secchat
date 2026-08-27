import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/widgets/call_button.dart';

import '../calls/fake_call_controller.dart';

void main() {
  Widget host(FakeCallController controller) => MaterialApp(
    home: Scaffold(
      body: GroupCallButton(controller: controller, channelId: 'chan_1'),
    ),
  );

  testWidgets('enabled when idle; disabled while already on a call', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));
    var button = tester.widget<PopupMenuButton<String>>(find.byType(PopupMenuButton<String>));
    expect(button.enabled, isTrue);

    controller.emit(const CallSnapshot(phase: CallPhase.active, channelId: 'chan_2', peerSub: 'carol'));
    await tester.pump();
    button = tester.widget<PopupMenuButton<String>>(find.byType(PopupMenuButton<String>));
    expect(button.enabled, isFalse);
  });

  testWidgets('tapping "Start call" calls startGroupCall', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));

    await tester.tap(find.byType(PopupMenuButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Start call'));
    await tester.pumpAndSettle();

    expect(controller.startGroupCallCalls, ['chan_1']);
    expect(controller.joinGroupCallCalls, isEmpty);
  });

  testWidgets('tapping "Join call" calls joinGroupCall', (tester) async {
    final controller = FakeCallController();
    await tester.pumpWidget(host(controller));

    await tester.tap(find.byType(PopupMenuButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Join call'));
    await tester.pumpAndSettle();

    expect(controller.joinGroupCallCalls, ['chan_1']);
    expect(controller.startGroupCallCalls, isEmpty);
  });
}
