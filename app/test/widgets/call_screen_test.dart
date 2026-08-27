import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/formatting.dart';
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

    testWidgets('camera/screen buttons are present on a live group call and toggle', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(phase: CallPhase.active, channelId: 'chan_1', isGroup: true),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Video'), findsOneWidget);
      expect(find.text('Share'), findsOneWidget);

      await tester.tap(find.text('Video'));
      expect(controller.toggleCameraCalls, 1);

      await tester.tap(find.text('Share'));
      expect(controller.toggleScreenShareCalls, 1);

      // Labels/colors flip once the snapshot reports the source is on --
      // the controller (real or fake) owns applying the toggle; this
      // asserts the button reflects whatever state it's given.
      controller.emit(controller.snapshot.copyWith(localCameraOn: true, localScreenOn: true));
      await tester.pump();

      expect(find.text('Stop video'), findsOneWidget);
      expect(find.text('Stop share'), findsOneWidget);
      expect(find.text('Video'), findsNothing);
      expect(find.text('Share'), findsNothing);
    });

    testWidgets('camera/screen buttons are present on a live 1:1 call', (tester) async {
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

      expect(find.text('Video'), findsOneWidget);
      expect(find.text('Share'), findsOneWidget);
    });

    testWidgets('camera/screen buttons are absent on a solo memo', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(phase: CallPhase.recordingMemo, channelId: 'chan_1', connectedAt: DateTime.now()),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Video'), findsNothing);
      expect(find.text('Stop video'), findsNothing);
      expect(find.text('Share'), findsNothing);
      expect(find.text('Stop share'), findsNothing);
    });

    testWidgets('a local camera preview shows only while the camera is on', (tester) async {
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

      expect(find.byKey(const Key('local-camera-preview')), findsNothing);

      controller.emit(controller.snapshot.copyWith(localCameraOn: true));
      await tester.pump();

      expect(find.byKey(const Key('local-camera-preview')), findsOneWidget);
    });
  });

  group('screen share stage', () {
    testWidgets('appears when a group participant is screen-sharing', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            isGroup: true,
            participants: {'bob': CallParticipant(sub: 'bob')},
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.byKey(const Key('screen-share-stage')), findsNothing);

      controller.emit(
        controller.snapshot.copyWith(
          participants: const {'bob': CallParticipant(sub: 'bob', screenOn: true)},
        ),
      );
      await tester.pump();

      expect(find.byKey(const Key('screen-share-stage')), findsOneWidget);
      expect(find.textContaining('Bob is sharing'), findsOneWidget);
    });

    testWidgets('appears for my own screen share when nobody else is sharing', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(phase: CallPhase.active, channelId: 'chan_1', isGroup: true),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      controller.emit(controller.snapshot.copyWith(localScreenOn: true));
      await tester.pump();

      expect(find.byKey(const Key('screen-share-stage')), findsOneWidget);
      expect(find.text('You are sharing your screen'), findsOneWidget);
    });

    testWidgets('a remote share wins the stage over a simultaneous local one', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            isGroup: true,
            localScreenOn: true,
            participants: {'bob': CallParticipant(sub: 'bob', screenOn: true)},
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.textContaining('Bob is sharing'), findsOneWidget);
      expect(find.text('You are sharing your screen'), findsNothing);
    });

    testWidgets('never appears for a solo memo (which never has screen state)', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(phase: CallPhase.recordingMemo, channelId: 'chan_1', connectedAt: DateTime.now()),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.byKey(const Key('screen-share-stage')), findsNothing);
    });
  });

  group('group call roster', () {
    testWidgets('shows a waiting message with no participants, then a tile per participant', (
      tester,
    ) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            isGroup: true,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Group call'), findsOneWidget);
      expect(find.text('Waiting for others to join…'), findsOneWidget);
      expect(find.byKey(const Key('participant-tile-bob')), findsNothing);

      // A participant joins (WsCallParticipantJoinedEvent -> the roster map
      // gains an entry) -- a tile for them appears.
      controller.emit(
        controller.snapshot.copyWith(
          participants: const {'bob': CallParticipant(sub: 'bob')},
        ),
      );
      await tester.pump();

      expect(find.text('Waiting for others to join…'), findsNothing);
      expect(find.byKey(const Key('participant-tile-bob')), findsOneWidget);
      expect(find.text('Bob'), findsOneWidget);

      // A second participant joins -- both tiles show.
      controller.emit(
        controller.snapshot.copyWith(
          participants: const {
            'bob': CallParticipant(sub: 'bob'),
            'carol': CallParticipant(sub: 'carol'),
          },
        ),
      );
      await tester.pump();

      expect(find.byKey(const Key('participant-tile-bob')), findsOneWidget);
      expect(find.byKey(const Key('participant-tile-carol')), findsOneWidget);

      // bob leaves (WsCallParticipantLeftEvent) -- their tile disappears,
      // carol's stays.
      controller.emit(
        controller.snapshot.copyWith(
          participants: const {'carol': CallParticipant(sub: 'carol')},
        ),
      );
      await tester.pump();

      expect(find.byKey(const Key('participant-tile-bob')), findsNothing);
      expect(find.byKey(const Key('participant-tile-carol')), findsOneWidget);
    });

    testWidgets('a participant tile renders video when a camera renderer is wired', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            isGroup: true,
            participants: {
              'bob': CallParticipant(sub: 'bob', cameraOn: true, cameraTrackId: 'cam-1'),
              'carol': CallParticipant(sub: 'carol'),
            },
          ),
        )
        // Only bob has a renderer actually wired -- carol falls back to her
        // avatar even though her `CallParticipant` doesn't drive that here
        // (a real controller resolves this from `MediaSession.remoteTracks`
        // instead; the fake exposes this as a plain testable seam).
        ..remoteCameraViewBuilder = (sub) => sub == 'bob' ? const SizedBox(key: Key('bob-video')) : null;
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.byKey(const Key('video-tile-bob')), findsOneWidget);
      expect(find.byKey(const Key('video-tile-carol')), findsNothing);
      // carol still gets her identity avatar (initials) since no renderer
      // was wired for her.
      expect(find.text(initialsFor('carol')), findsOneWidget);
    });

    testWidgets('the 1:1 branch renders the peer\'s video when a camera renderer is wired', (tester) async {
      final controller = FakeCallController()
        ..emit(
          CallSnapshot(
            phase: CallPhase.active,
            channelId: 'chan_1',
            peerSub: 'bob',
            connectedAt: DateTime.now(),
          ),
        )
        ..remoteCameraViewBuilder = (sub) => sub == 'bob' ? const SizedBox(key: Key('bob-video')) : null;
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.byKey(const Key('video-tile-bob')), findsOneWidget);
    });

    testWidgets('a group call ended shows "Call Ended" without the memo transcript hint', (tester) async {
      final controller = FakeCallController()
        ..emit(
          const CallSnapshot(
            phase: CallPhase.ended,
            channelId: 'chan_1',
            isGroup: true,
            endReason: CallEndReason.hangup,
          ),
        );
      await tester.pumpWidget(host(controller));
      await tester.pump();

      expect(find.text('Call Ended'), findsOneWidget);
      // Group calls aren't memos -- the "your voice memo is saved" copy
      // (which peerSub == null alone would otherwise trigger) must not show.
      expect(find.textContaining('transcript will appear'), findsNothing);
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
