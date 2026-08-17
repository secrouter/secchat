import 'package:secchat_app/calls/call_controller.dart';
import 'package:secchat_app/models.dart';

/// In-memory [CallController] for widget tests -- no WebRTC, no network.
/// Tests drive it directly (`emit(...)`) instead of going through real
/// `call_*` WS frames; the action methods just record what was called so a
/// test can assert on intent (e.g. "accept was called with consent: true")
/// without a real signaling round-trip.
class FakeCallController extends CallController {
  CallSnapshot _snapshot = const CallSnapshot();
  @override
  CallSnapshot get snapshot => _snapshot;

  /// Push a new state and notify listeners -- how a test simulates a `call_*`
  /// event arriving (rather than constructing a real [WsEvent] and routing it
  /// through [handleEvent], which this fake doesn't implement).
  void emit(CallSnapshot next) {
    _snapshot = next;
    notifyListeners();
  }

  final List<({String channelId, String peerSub, bool wantRecording})> startCalls = [];
  final List<({String channelId, bool wantRecording, bool enroll})> startSoloRecordCalls = [];
  final List<String> startGroupCallCalls = [];
  final List<String> joinGroupCallCalls = [];
  final List<bool> acceptCalls = [];
  int declineOrCancelCalls = 0;
  int hangUpCalls = 0;
  int toggleMuteCalls = 0;
  int dismissCalls = 0;

  @override
  void handleEvent(WsEvent event) {
    // Not exercised by these tests -- the fake is driven via [emit] instead.
  }

  @override
  Future<void> startCall({
    required String channelId,
    required String peerSub,
    required bool wantRecording,
  }) async {
    startCalls.add((channelId: channelId, peerSub: peerSub, wantRecording: wantRecording));
  }

  @override
  Future<void> startSoloRecord({
    required String channelId,
    required bool wantRecording,
    bool enroll = false,
  }) async {
    startSoloRecordCalls.add((channelId: channelId, wantRecording: wantRecording, enroll: enroll));
  }

  @override
  Future<void> startGroupCall(String channelId) async {
    startGroupCallCalls.add(channelId);
  }

  @override
  Future<void> joinGroupCall(String channelId) async {
    joinGroupCallCalls.add(channelId);
  }

  @override
  Future<void> accept({required bool consent}) async {
    acceptCalls.add(consent);
  }

  @override
  void declineOrCancel() {
    declineOrCancelCalls++;
  }

  @override
  void hangUp() {
    hangUpCalls++;
  }

  @override
  void toggleMute() {
    toggleMuteCalls++;
  }

  @override
  void dismiss() {
    dismissCalls++;
  }
}
