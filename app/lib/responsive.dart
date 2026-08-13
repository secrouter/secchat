import 'package:flutter/widgets.dart';

/// Layout breakpoints.
///
/// SecChat's desktop chrome is a two-pane [Row]: a fixed 258pt [ChatSidebar]
/// beside the transcript. Below [kCompactWidth] that leaves too little room for
/// either pane (on a 390pt phone the transcript gets ~130pt), so the layout
/// switches to a single pane with the sidebar behind a drawer.
///
/// Everything at or above the breakpoint is unchanged — the wide branch builds
/// exactly the widget tree it always did.
const double kCompactWidth = 720;

/// True when the window is narrow enough to need the single-pane layout.
///
/// Prefer the [BoxConstraints] form inside a [LayoutBuilder] when you already
/// have one; this reads the window and is the right call for dialogs, which are
/// laid out against the screen rather than their parent.
bool isCompact(BuildContext context) =>
    MediaQuery.sizeOf(context).width < kCompactWidth;

/// Dialog sizing helper: dialogs currently hard-code widths (360–480) that
/// exceed a phone viewport. This keeps the desktop width as a MAXIMUM and lets
/// a narrow screen shrink instead of overflowing.
double dialogWidth(BuildContext context, double preferred) {
  final w = MediaQuery.sizeOf(context).width;
  // 32 = 16pt of breathing room either side of the dialog.
  return w - 32 < preferred ? w - 32 : preferred;
}
