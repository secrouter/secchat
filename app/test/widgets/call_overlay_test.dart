import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/models.dart' show CallMode;
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

  group('in-call bar', () {
    testWidgets('active call shows peer, duration, mute + hang up', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            amCaller: true,
            mode: CallMode.p2p,
            connectedAt: DateTime.now(),
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump(); // let the 1s ticker's initial frame settle

      expect(find.text('Bob'), findsOneWidget);
      expect(find.byTooltip('Mute'), findsOneWidget);
      expect(find.byTooltip('Hang up'), findsOneWidget);
      // p2p mode never shows ● REC.
      expect(find.text('REC'), findsNothing);

      await tester.tap(find.byTooltip('Hang up'));
      expect(controller.hangUpCalls, 1);
    });

    testWidgets('relayed + recording shows the ● REC indicator (server-pushed recordingOn, finding #7 -- truthful by construction, not derived from mode)', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            mode: CallMode.relayed,
            recordingOn: true,
            connectedAt: DateTime.now(),
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('REC'), findsOneWidget);
    });

    testWidgets('relayed mode alone, before the server pushes call_recording, does NOT show ● REC (no guessing from mode)', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            mode: CallMode.relayed,
            connectedAt: DateTime.now(),
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('REC'), findsNothing);
    });

    testWidgets('mediad-down downgrade shows the recording-unavailable notice', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.connecting,
            channelId: 'chan_1',
            peerSub: 'bob',
            mode: CallMode.p2p,
            recordingUnavailableNotice: true,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.textContaining('will NOT be recorded'), findsOneWidget);
    });

    testWidgets('tapping mute toggles it', (tester) async {
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

      await tester.tap(find.byTooltip('Mute'));
      expect(controller.toggleMuteCalls, 1);
    });
  });

  group('call-ended banner', () {
    testWidgets('shows the end reason and dismisses on tap', (tester) async {
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

      expect(find.textContaining('Missed call'), findsOneWidget);
      await tester.tap(find.textContaining('Missed call'));
      expect(controller.dismissCalls, 1);
    });

    testWidgets('a failure shows the error message', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.ended,
            channelId: 'chan_1',
            peerSub: 'bob',
            endReason: CallEndReason.failed,
            errorMessage: 'Could not access the microphone',
          ),
        );
      await tester.pumpWidget(host(controller));

      expect(find.text('Could not access the microphone'), findsOneWidget);
    });
  });
}
