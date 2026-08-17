import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/widgets/call_screen.dart';

import '../calls/fake_call_controller.dart';

void main() {
  Widget host(FakeCallController controller) => MaterialApp(
    home: CallScreen(
      controller: controller,
      labelForSub: (sub) => sub == 'bob' ? 'Bob' : sub,
    ),
  );

  AnimatedFractionallySizedBox micFill(WidgetTester tester) =>
      tester.widget<AnimatedFractionallySizedBox>(find.byKey(const Key('mic-level-fill')));

  group('mic-level meter', () {
    testWidgets('reflects a silent mic as an empty bar', (tester) async {
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

      expect(micFill(tester).widthFactor, 0.0);
    });

    testWidgets('tracks snapshot.micLevel as it changes (e.g. speaking into a live mic)', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            connectedAt: DateTime.now(),
            micLevel: 0.15,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();
      expect(micFill(tester).widthFactor, closeTo(0.15, 1e-9));

      // A fresh poll (e.g. the 150ms controller timer) pushes a new level --
      // the meter should track it, which is the whole debug point: a flat
      // meter despite speaking means a dead mic.
      controller.emit(controller.snapshot.copyWith(micLevel: 0.82));
      await tester.pump();
      expect(micFill(tester).widthFactor, closeTo(0.82, 1e-9));
    });

    testWidgets('clamps an out-of-range level rather than overflowing the bar', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            connectedAt: DateTime.now(),
            micLevel: 1.4,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(micFill(tester).widthFactor, 1.0);
    });
  });

  group('title/status', () {
    testWidgets('a 2-party call shows the peer name and REC only when the server confirms recording', (
      tester,
    ) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            connectedAt: DateTime.now(),
            recordingOn: true,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Bob'), findsOneWidget);
      expect(find.text('REC'), findsOneWidget);
      expect(find.text('End call'), findsOneWidget);
      expect(find.text('Mute'), findsOneWidget);
    });

    testWidgets('a mediad-down downgrade shows the recording-unavailable notice', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.connecting,
            channelId: 'chan_1',
            peerSub: 'bob',
            recordingUnavailableNotice: true,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.textContaining('will NOT be recorded'), findsOneWidget);
    });

    testWidgets('the callee declining recording shows the declined notice', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            connectedAt: DateTime.now(),
            recordingDeclinedNotice: true,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.textContaining('declined recording'), findsOneWidget);
    });

    testWidgets('a solo voice memo shows "Voice memo", always REC, Stop, and no mute control', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.recordingMemo,
            channelId: 'chan_1',
            connectedAt: DateTime.now(),
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Voice memo'), findsOneWidget);
      expect(find.text('REC'), findsOneWidget);
      expect(find.text('Stop'), findsOneWidget);
      expect(find.text('Mute'), findsNothing);
      expect(find.text('Unmute'), findsNothing);
    });
  });

  group('controls', () {
    testWidgets('tapping End call hangs up', (tester) async {
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

      await tester.tap(find.text('End call'));
      expect(controller.hangUpCalls, 1);
    });

    testWidgets('tapping Mute toggles it', (tester) async {
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

      await tester.tap(find.text('Mute'));
      expect(controller.toggleMuteCalls, 1);
    });

    testWidgets('tapping Stop on a memo hangs up', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(phase: CallPhase.recordingMemo, channelId: 'chan_1', connectedAt: DateTime.now()),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      await tester.tap(find.text('Stop'));
      expect(controller.hangUpCalls, 1);
    });
  });

  group('ended view', () {
    testWidgets('a memo shows "Call Ended" + a transcript hint; Close dismisses', (tester) async {
      final controller = FakeCallController()
        ..emit(const CallSnapshot(phase: CallPhase.ended, channelId: 'chan_1', endReason: CallEndReason.hangup));
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Call Ended'), findsOneWidget);
      expect(find.textContaining('transcript will appear'), findsOneWidget);

      await tester.tap(find.text('Close'));
      expect(controller.dismissCalls, 1);
    });

    testWidgets('a failed call surfaces the error message', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.ended,
            channelId: 'chan_1',
            peerSub: 'bob',
            endReason: CallEndReason.failed,
            errorMessage: 'the recording service is unavailable',
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Call Ended'), findsOneWidget);
      expect(find.text('the recording service is unavailable'), findsOneWidget);
    });
  });
}
