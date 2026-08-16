import 'package:flutter_test/flutter_test.dart';
import 'package:secchat_app/calls/call_controller.dart';

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
}
