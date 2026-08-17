import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/models.dart';

import '../fakes/fake_api_client.dart';

void main() {
  // [WebrtcCallController.startSoloRecord] only needs to get as far as
  // sending `call_solo_start` and flipping local state for these tests --
  // the rest of the flow (MediaSession/WebRTC, applying the `call_accept`
  // echo) needs a real platform channel and isn't exercised here, same as
  // there being no existing unit test for [WebrtcCallController.startCall]'s
  // `call_invite` send either.
  test('startSoloRecord sends call_solo_start and enters recordingMemo', () async {
    final api = FakeApiClient();
    final controller = WebrtcCallController(api: api, mySub: 'dev.tester');

    await controller.startSoloRecord(channelId: 'self-dm-1', wantRecording: true);

    expect(api.callSoloStartCalls, [
      (channelId: 'self-dm-1', wantRecording: true, enroll: false),
    ]);
    expect(controller.snapshot.phase, CallPhase.recordingMemo);
    expect(controller.snapshot.channelId, 'self-dm-1');
    expect(controller.snapshot.amCaller, isTrue);
    expect(controller.snapshot.wantRecording, isTrue);
  });

  test('startSoloRecord with enroll:true forwards enroll on the frame', () async {
    final api = FakeApiClient();
    final controller = WebrtcCallController(api: api, mySub: 'dev.tester');

    await controller.startSoloRecord(channelId: 'self-dm-1', wantRecording: true, enroll: true);

    expect(api.callSoloStartCalls, [
      (channelId: 'self-dm-1', wantRecording: true, enroll: true),
    ]);
  });

  test('startSoloRecord is a no-op while already on a call/memo', () async {
    final api = FakeApiClient();
    final controller = WebrtcCallController(api: api, mySub: 'dev.tester');
    await controller.startSoloRecord(channelId: 'self-dm-1', wantRecording: true);

    await controller.startSoloRecord(channelId: 'self-dm-2', wantRecording: true);

    // Only the first call went out — the second was gated by the idle check,
    // same single-flight guard [startCall] uses.
    expect(api.callSoloStartCalls.length, 1);
    expect(controller.snapshot.channelId, 'self-dm-1');
  });

  group('call_media (video-calls wire contract)', () {
    test('WsCallMediaEvent updates a 1:1 peer\'s camera/screen state', () async {
      final api = FakeApiClient();
      final controller = WebrtcCallController(api: api, mySub: 'dev.tester');
      await controller.startCall(channelId: 'chan-1', peerSub: 'dev.bob', wantRecording: false);

      controller.handleEvent(
        const WsCallMediaEvent(
          sub: 'dev.bob',
          cameraOn: true,
          screenOn: false,
          cameraTrackId: 'cam-track-1',
          channelId: 'chan-1',
        ),
      );

      final peer = controller.snapshot.participants['dev.bob'];
      expect(peer, isNotNull);
      expect(peer!.cameraOn, isTrue);
      expect(peer.screenOn, isFalse);
      expect(peer.cameraTrackId, 'cam-track-1');

      // A follow-up toggle (screen on, camera off) replaces the entry
      // rather than merging — matches the wire contract sending the FULL
      // current state on every toggle, not a delta.
      controller.handleEvent(
        const WsCallMediaEvent(
          sub: 'dev.bob',
          cameraOn: false,
          screenOn: true,
          screenTrackId: 'screen-track-1',
          channelId: 'chan-1',
        ),
      );
      final updated = controller.snapshot.participants['dev.bob'];
      expect(updated!.cameraOn, isFalse);
      expect(updated.screenOn, isTrue);
      expect(updated.screenTrackId, 'screen-track-1');
    });

    test('WsCallMediaEvent for a different channel is ignored', () async {
      final api = FakeApiClient();
      final controller = WebrtcCallController(api: api, mySub: 'dev.tester');
      await controller.startCall(channelId: 'chan-1', peerSub: 'dev.bob', wantRecording: false);

      controller.handleEvent(
        const WsCallMediaEvent(
          sub: 'dev.bob',
          cameraOn: true,
          screenOn: false,
          channelId: 'chan-OTHER',
        ),
      );

      expect(controller.snapshot.participants, isEmpty);
    });

    // [toggleCamera]/[toggleScreenShare]'s happy path (actually acquiring a
    // track and sending `call_media`) needs a real [MediaSession] backed by
    // a platform channel this test environment doesn't have — same
    // limitation this file's other tests already work around (see the top
    // comment). What IS exercised here without one: the live-call guard
    // both share with [toggleMute] -- neither should reach the API (or
    // touch `localCameraOn`/`localScreenOn`) before a call is actually live.
    test('toggleCamera/toggleScreenShare are no-ops before a call is live', () async {
      final api = FakeApiClient();
      final controller = WebrtcCallController(api: api, mySub: 'dev.tester');

      controller.toggleCamera();
      controller.toggleScreenShare();

      expect(api.callMediaCalls, isEmpty);
      expect(controller.snapshot.localCameraOn, isFalse);
      expect(controller.snapshot.localScreenOn, isFalse);
    });

    test('toggleCamera/toggleScreenShare are no-ops during a solo memo', () async {
      final api = FakeApiClient();
      final controller = WebrtcCallController(api: api, mySub: 'dev.tester');
      await controller.startSoloRecord(channelId: 'self-dm-1', wantRecording: true);

      controller.toggleCamera();
      controller.toggleScreenShare();

      expect(api.callMediaCalls, isEmpty);
      expect(controller.snapshot.localCameraOn, isFalse);
      expect(controller.snapshot.localScreenOn, isFalse);
    });
  });
}
