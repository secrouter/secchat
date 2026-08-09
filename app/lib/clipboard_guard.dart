import 'package:flutter/services.dart';

import 'marking.dart';

/// What to do with a guarded paste.
enum PasteGuardAction {
  /// Insert as usual (untracked content, or the destination can hold it).
  allow,

  /// Refuse the paste — the source marking exceeds a marked channel's ceiling.
  block,

  /// Insert, but RAISE the composer's marking to [PasteDecision.targetMarking]
  /// so higher-marked content isn't sent under a lower per-message marking.
  raise,
}

/// The outcome of [ClipboardGuard.decidePaste].
class PasteDecision {
  const PasteDecision(this.action, {this.sourceMarking, this.targetMarking});

  final PasteGuardAction action;

  /// The copied content's marking (present for `block` and `raise`).
  final String? sourceMarking;

  /// The marking to raise the composer to (present for `raise`).
  final String? targetMarking;

  static const allow = PasteDecision(PasteGuardAction.allow);
}

/// Tracks the classification PROVENANCE of content copied *in-app*, so a paste
/// into a lower-marked destination is caught at the point of paste. This is
/// defense-in-depth and a UX affordance — the server still enforces the channel
/// ceiling on every post, so a bypass can't actually spill; the guard stops the
/// accident (and the marking-propagation) before the user hits Send.
///
/// It deliberately only guards content it KNOWS came from an in-app copy of a
/// marked message (matched by exact text): arbitrary external clipboard content
/// has no known marking and is never blocked.
class ClipboardGuard {
  String? _text;
  String? _marking;

  bool get hasProvenance => _text != null;

  /// Record an in-app copy of [text] carrying [marking] and put it on the system
  /// clipboard. Later pastes of this exact text are guarded against the destination.
  Future<void> recordCopy(String text, String marking) async {
    _text = text;
    _marking = marking;
    await Clipboard.setData(ClipboardData(text: text));
  }

  void clear() {
    _text = null;
    _marking = null;
  }

  /// Decide what to do with a paste of [pastedText].
  ///
  /// [channelMarking] non-null ⇒ a marked channel with a fixed ceiling; null ⇒
  /// an unmarked channel where [destinationMarking] is the current per-message
  /// marking (which can be raised).
  PasteDecision decidePaste({
    required String pastedText,
    required String? channelMarking,
    required String destinationMarking,
    required MarkingPolicy policy,
  }) {
    // Only guard content we recorded as an in-app copy of a marked message.
    if (_text == null || _marking == null || _text != pastedText) return PasteDecision.allow;
    final source = _marking!;
    // Baseline, un-categorized content carries no restriction — never guarded.
    if (!policy.isElevated(source) && markingCategoriesOf(source).isEmpty) return PasteDecision.allow;

    if (channelMarking != null) {
      // Marked channel: the ceiling is fixed. If it can't dominate the source, that's spillage.
      return markingDominates(policy, channelMarking, source)
          ? PasteDecision.allow
          : PasteDecision(PasteGuardAction.block, sourceMarking: source);
    }
    // Unmarked channel: the per-message marking is raisable — propagate the source marking up.
    if (markingDominates(policy, destinationMarking, source)) return PasteDecision.allow;
    return PasteDecision(
      PasteGuardAction.raise,
      sourceMarking: source,
      targetMarking: markingJoin(policy, destinationMarking, source),
    );
  }
}
