import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/widgets/call_overlay.dart';

import '../calls/fake_call_controller.dart';

void main() {
  Widget host(FakeCallController controller) => MaterialApp(
    home: CallOverlay(
      controller: controller,
      labelForSub: (sub) => sub == 'bob' ? 'Bob' : sub,
      child: const Scaffold(body: Center(child: Text('channel content'))),
    ),
  );

  group('ring screen', () {
    testWidgets('inbound call without a recording ask shows Decline/Accept only', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.ringingInbound,
            channelId: 'chan_1',
            peerSub: 'bob',
            amCaller: false,
            wantRecording: false,
          ),
        );
      await tester.pumpWidget(host(controller));

      expect(find.text('Bob'), findsOneWidget);
      expect(find.text('Incoming call'), findsOneWidget);
      expect(find.text('Decline'), findsOneWidget);
      expect(find.text('Accept'), findsOneWidget);
      // No consent explainer, no "no recording" affordance, for a plain call.
      expect(find.textContaining('wants to record'), findsNothing);

      await tester.tap(find.text('Decline'));
      expect(controller.declineOrCancelCalls, 1);
    });

    testWidgets('inbound call WITH a recording ask shows the consent explainer + 3 actions', (
      tester,
    ) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.ringingInbound,
            channelId: 'chan_1',
            peerSub: 'bob',
            amCaller: false,
            wantRecording: true,
          ),
        );
      await tester.pumpWidget(host(controller));

      expect(find.textContaining('wants to record this call'), findsOneWidget);
      expect(find.text('Decline'), findsOneWidget);
      expect(find.textContaining('Accept'), findsWidgets); // "Accept &\nrecord" + "Accept\n(no recording)"

      await tester.tap(find.textContaining('no recording'));
      expect(controller.acceptCalls, [false]);

      await tester.tap(find.text('Accept &\nrecord'));
      expect(controller.acceptCalls, [false, true]);
    });

    testWidgets('outbound ring shows Calling… and a Cancel button', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.ringingOutbound,
            channelId: 'chan_1',
            peerSub: 'bob',
            amCaller: true,
          ),
        );
      await tester.pumpWidget(host(controller));

      expect(find.text('Calling…'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      expect(controller.declineOrCancelCalls, 1);
    });
  });

  // The sustained in-call bar (mute/hang-up/●REC/duration/mic meter) and the
  // solo-memo bar used to be covered here, but that UI moved to the
  // full-screen `CallScreen` (see `call_screen_test.dart`) -- `CallOverlay`
  // no longer renders anything for `isLive`/`recordingMemo` (see its class
  // doc); those states now render nothing here on purpose so they don't
  // double up with -- and physically overlap -- `ChatScreen`'s Call tab.
  testWidgets('a live/recordingMemo call renders nothing from CallOverlay itself (moved to CallScreen)', (
    tester,
  ) async {
    final controller = FakeCallController()
      ..emit(
        CallSnapshot(
          phase: CallPhase.active,
          channelId: 'chan_1',
          peerSub: 'bob',
          connectedAt: DateTime.now(),
        ),
      );
    await tester.pumpWidget(host(controller));
    await tester.pump();

    expect(find.byTooltip('Mute'), findsNothing);
    expect(find.byTooltip('Hang up'), findsNothing);
    expect(find.text('REC'), findsNothing);
    // The wrapped chat content underneath is still there, unobstructed.
    expect(find.text('channel content'), findsOneWidget);
  });

  // The old auto-dismiss "call ended" banner is gone — the ended state now lives
  // in CallScreen's full-screen "Call Ended" view (see call_screen_test.dart),
  // which the user closes explicitly. CallOverlay renders nothing for it.
  testWidgets('renders nothing for the ended phase (no banner)', (tester) async {
    final controller = FakeCallController()
      ..emit(
        const CallSnapshot(
          phase: CallPhase.ended,
          channelId: 'chan_1',
          peerSub: 'bob',
          endReason: CallEndReason.missed,
        ),
      );
    await tester.pumpWidget(host(controller));
    await tester.pump();

    expect(find.textContaining('Missed call'), findsNothing);
    expect(find.text('Call Ended'), findsNothing);
    expect(find.text('channel content'), findsOneWidget);
  });
}
