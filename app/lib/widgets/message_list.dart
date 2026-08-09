import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../formatting.dart';
import '../models.dart';
import '../theme.dart';
import 'empty_state.dart';
import 'markdown_text.dart';

/// The assistant's in-flight response for a channel: accumulated
/// `assistant_delta` text, rendered as a growing bubble until the matching
/// `message` event finalizes it.
class TypingState {
  const TypingState(this.agentId, this.text);

  final String agentId;
  final String text;
}

/// Scrollable transcript: persisted [TranscriptEntry] history plus, at the
/// tail, a live [TypingState] bubble. Auto-scrolls to the bottom whenever
/// new content arrives.
class MessageList extends StatefulWidget {
  const MessageList({
    super.key,
    required this.entries,
    required this.currentUserSub,
    this.typing,
  });

  final List<TranscriptEntry> entries;
  final String currentUserSub;
  final TypingState? typing;

  @override
  State<MessageList> createState() => _MessageListState();
}

class _MessageListState extends State<MessageList> {
  final _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
  }

  @override
  void didUpdateWidget(covariant MessageList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final changed =
        oldWidget.entries.length != widget.entries.length ||
        oldWidget.typing?.text.length != widget.typing?.text.length ||
        oldWidget.typing?.agentId != widget.typing?.agentId;
    if (changed) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToBottom());
    }
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    _scrollController.animateTo(
      _scrollController.position.maxScrollExtent,
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOut,
    );
  }

  @override
  Widget build(BuildContext context) {
    final itemCount = widget.entries.length + (widget.typing != null ? 1 : 0);
    if (itemCount == 0) {
      return const EmptyState(
        icon: Icons.chat_bubble_outline,
        title: 'No messages yet',
        subtitle: 'Say hello to get things started.',
      );
    }
    return Scrollbar(
      controller: _scrollController,
      child: ListView.builder(
        controller: _scrollController,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 18),
        itemCount: itemCount,
        itemBuilder: (context, index) {
          if (index < widget.entries.length) {
            return _TranscriptTile(
              entry: widget.entries[index],
              currentUserSub: widget.currentUserSub,
            );
          }
          return _TypingBubble(typing: widget.typing!);
        },
      ),
    );
  }
}

class _TranscriptTile extends StatelessWidget {
  const _TranscriptTile({required this.entry, required this.currentUserSub});

  final TranscriptEntry entry;
  final String currentUserSub;

  @override
  Widget build(BuildContext context) {
    return switch (entry) {
      MessageEntry(:final message) => _MessageBubble(
        message: message,
        isOwn:
            message.authorType == AuthorType.user &&
            message.authorRef == currentUserSub,
      ),
      AgentOutputEntry(:final text) => _OutputTile(text: text),
      ToolDecisionEntry(:final tool, :final allow, :final reason) =>
        _DecisionTile(tool: tool, allow: allow, reason: reason),
      SystemEntry(:final text) => _SystemDivider(text: text),
    };
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.isOwn});

  final Message message;
  final bool isOwn;

  @override
  Widget build(BuildContext context) {
    final isAgent = message.authorType == AuthorType.agent;
    final authorColor = isAgent || isOwn ? AppColors.accent : AppColors.text;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: isAgent ? AppColors.accentSoft : Colors.transparent,
        border: Border(
          left: BorderSide(
            color: isAgent ? AppColors.accentBorder : Colors.transparent,
            width: 2,
          ),
        ),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Avatar(ref: message.authorRef, isAgent: isAgent),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.baseline,
                  textBaseline: TextBaseline.alphabetic,
                  children: [
                    Flexible(
                      child: Text(
                        message.authorRef,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w700,
                          color: authorColor,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      formatClockTime(message.createdAt),
                      style: AppFonts.mono(
                        fontSize: 11,
                        color: AppColors.textFaint,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                message.isRedacted
                    ? const Text(
                        'message redacted',
                        style: TextStyle(
                          fontStyle: FontStyle.italic,
                          color: AppColors.textFaint,
                          fontSize: 14,
                        ),
                      )
                    : MarkdownText(
                        message.content!,
                        baseStyle: const TextStyle(
                          color: AppColors.text,
                          fontSize: 14,
                          height: 1.4,
                        ),
                      ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.ref, required this.isAgent});

  final String ref;
  final bool isAgent;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 28,
      height: 28,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: AppColors.surfaceRaised,
        shape: BoxShape.circle,
        border: Border.all(
          color: isAgent ? AppColors.accentBorder : AppColors.border,
        ),
      ),
      child: isAgent
          ? const Icon(Icons.auto_awesome, size: 13, color: AppColors.accent)
          : Text(
              initialsFor(ref),
              style: const TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w700,
                color: AppColors.textMuted,
              ),
            ),
    );
  }
}

/// Renders a live `agent_output` event -- runner/tool stdout, log-like and
/// monospaced, visually distinct from chat.
class _OutputTile extends StatelessWidget {
  const _OutputTile({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3, horizontal: 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: const BoxDecoration(
        color: AppColors.surfaceAlt,
        border: Border(left: BorderSide(color: AppColors.textFaint, width: 2)),
        borderRadius: BorderRadius.horizontal(
          right: Radius.circular(AppRadius.sm),
        ),
      ),
      child: RichText(
        text: TextSpan(
          children: [
            TextSpan(
              text: 'OUTPUT  ',
              style: AppFonts.mono(
                fontSize: 10,
                color: AppColors.textFaint,
                letterSpacing: 0.6,
                fontWeight: FontWeight.w700,
              ),
            ),
            TextSpan(
              text: text,
              style: AppFonts.mono(fontSize: 12.5, color: AppColors.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}

/// Renders a live `tool_decision` event as an allow (green) / deny (red)
/// chip -- the visible half of the plan/execute gate.
class _DecisionTile extends StatelessWidget {
  const _DecisionTile({required this.tool, required this.allow, this.reason});

  final String tool;
  final bool allow;
  final String? reason;

  @override
  Widget build(BuildContext context) {
    final color = allow ? AppColors.ok : AppColors.bad;
    final bg = allow ? AppColors.okBg : AppColors.badBg;
    final borderColor = allow ? AppColors.okBorder : AppColors.badBorder;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3, horizontal: 4),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: bg,
        border: Border(left: BorderSide(color: borderColor, width: 2)),
        borderRadius: const BorderRadius.horizontal(
          right: Radius.circular(AppRadius.sm),
        ),
      ),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 9,
        runSpacing: 4,
        children: [
          Icon(
            allow ? Icons.check_circle : Icons.cancel,
            size: 14,
            color: color,
          ),
          Text(
            tool,
            style: AppFonts.mono(
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              color: color,
            ),
          ),
          if (reason != null && reason!.isNotEmpty)
            Text(
              reason!,
              style: const TextStyle(
                fontSize: 12.5,
                color: AppColors.textMuted,
              ),
            ),
        ],
      ),
    );
  }
}

/// Centered, ruled divider for system entries like "Session ended".
class _SystemDivider extends StatelessWidget {
  const _SystemDivider({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 4),
      child: Row(
        children: [
          const Expanded(
            child: Divider(color: AppColors.borderSoft, height: 1),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(
              text.toUpperCase(),
              style: const TextStyle(
                fontSize: 11.5,
                color: AppColors.textFaint,
                letterSpacing: 0.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const Expanded(
            child: Divider(color: AppColors.borderSoft, height: 1),
          ),
        ],
      ),
    );
  }
}

/// The growing "assistant is typing…" bubble built from `assistant_delta`
/// events: bouncing dots before any text has arrived, then the streamed
/// text with a blinking caret.
class _TypingBubble extends StatelessWidget {
  const _TypingBubble({required this.typing});

  final TypingState typing;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 2),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: AppColors.accentSoft,
        border: const Border(
          left: BorderSide(color: AppColors.accentBorder, width: 2),
        ),
        borderRadius: BorderRadius.circular(AppRadius.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _Avatar(ref: 'assistant', isAgent: true),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Assistant',
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w700,
                    color: AppColors.accent,
                  ),
                ),
                const SizedBox(height: 2),
                if (typing.text.isEmpty)
                  const _TypingDots()
                else
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(
                          text: typing.text,
                          style: const TextStyle(
                            color: AppColors.text,
                            fontSize: 14,
                            height: 1.4,
                          ),
                        ),
                        const WidgetSpan(
                          alignment: PlaceholderAlignment.middle,
                          child: _BlinkingCaret(),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 13,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: List.generate(3, (i) {
              final phase = (_controller.value + i / 3) % 1.0;
              final bounce =
                  (math.sin(phase * 2 * math.pi - math.pi / 2) + 1) / 2;
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 1.5),
                child: Transform.translate(
                  offset: Offset(0, -3.0 * bounce),
                  child: Opacity(
                    opacity: 0.35 + 0.65 * bounce,
                    child: const _Dot(),
                  ),
                ),
              );
            }),
          );
        },
      ),
    );
  }
}

class _Dot extends StatelessWidget {
  const _Dot();

  @override
  Widget build(BuildContext context) => Container(
    width: 5,
    height: 5,
    decoration: const BoxDecoration(
      color: AppColors.accent,
      shape: BoxShape.circle,
    ),
  );
}

class _BlinkingCaret extends StatefulWidget {
  const _BlinkingCaret();

  @override
  State<_BlinkingCaret> createState() => _BlinkingCaretState();
}

class _BlinkingCaretState extends State<_BlinkingCaret>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        return Opacity(
          opacity: _controller.value < 0.5 ? 1 : 0,
          child: Container(
            width: 6,
            height: 14,
            margin: const EdgeInsets.only(left: 2),
            color: AppColors.accent,
          ),
        );
      },
    );
  }
}
