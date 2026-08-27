/// Markdown renderer for chat message bodies (used by `_MessageBubble` in
/// `lib/widgets/message_list.dart`).
///
/// Backed by `flutter_markdown_plus` (the maintained continuation of the now-
/// discontinued official `flutter_markdown`) for full CommonMark + GitHub-
/// flavored markdown, plus `flutter_markdown_plus_latex` for `$…$` inline and
/// `$$…$$` block LaTeX math — both permissively licensed and vendorable for
/// air-gapped builds. Styled entirely from `AppColors` so it matches the dark
/// "dev chat" look, with fenced code blocks as the centerpiece.
///
/// Streaming-safe: agent output arrives incrementally, so a message body is
/// frequently a *partial* markdown document (an unterminated ``` fence, a lone
/// `*`) until the next delta lands. The parser renders partial input as-is
/// rather than throwing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_markdown_plus_latex/flutter_markdown_plus_latex.dart';
import 'package:markdown/markdown.dart' as md;

import '../platform/link_launcher.dart';
import '../theme.dart';

/// GitHub-flavored markdown (tables, strikethrough, fenced code, autolinks, …)
/// PLUS LaTeX block/inline math, merged into one extension set so a message can
/// use both. Built once — the syntaxes are stateless.
final md.ExtensionSet _gfmWithLatex = md.ExtensionSet(
  <md.BlockSyntax>[
    ...md.ExtensionSet.gitHubFlavored.blockSyntaxes,
    LatexBlockSyntax(),
  ],
  <md.InlineSyntax>[
    LatexInlineSyntax(),
    ...md.ExtensionSet.gitHubFlavored.inlineSyntaxes,
  ],
);

/// Renders [text] as markdown. [baseStyle] seeds the paragraph text style
/// (headings/code/links/etc. layer on top); defaults to the message-body look.
class MarkdownText extends StatelessWidget {
  const MarkdownText(this.text, {this.baseStyle, super.key});

  final String text;
  final TextStyle? baseStyle;

  @override
  Widget build(BuildContext context) {
    final base =
        baseStyle ??
        TextStyle(color: AppColors.text, fontSize: 14, height: 1.4);
    return MarkdownBody(
      data: text,
      // Not selectable: SelectableText internals break existing widget-test
      // `find.text(...)` lookups, and the message bubble isn't a text editor.
      selectable: false,
      shrinkWrap: true,
      fitContent: true,
      onTapLink: (linkText, href, title) {
        if (href != null && href.isNotEmpty) openLinkUrl(href);
      },
      extensionSet: _gfmWithLatex,
      builders: <String, MarkdownElementBuilder>{
        'latex': LatexElementBuilder(
          textStyle: base.copyWith(color: AppColors.text),
          textScaleFactor: 1.1,
        ),
      },
      styleSheet: _sheet(base),
    );
  }

  MarkdownStyleSheet _sheet(TextStyle base) {
    const mono = TextStyle(
      fontFamily: 'monospace',
      fontFeatures: [FontFeature.tabularFigures()],
    );
    return MarkdownStyleSheet(
      p: base,
      a: TextStyle(
        color: AppColors.link,
        decoration: TextDecoration.underline,
        decorationColor: AppColors.link,
      ),
      strong: base.copyWith(fontWeight: FontWeight.w700),
      em: base.copyWith(fontStyle: FontStyle.italic),
      del: base.copyWith(decoration: TextDecoration.lineThrough),
      // Inline code: monospace with a subtle chip background.
      code: mono.copyWith(
        color: AppColors.text,
        backgroundColor: AppColors.codeBg,
        fontSize: (base.fontSize ?? 14) - 1,
      ),
      // Fenced code block: the dev-chat centerpiece — bordered, tinted, mono.
      codeblockDecoration: BoxDecoration(
        color: AppColors.codeBg,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: AppColors.codeBorder),
      ),
      codeblockPadding: const EdgeInsets.all(10),
      h1: base.copyWith(fontSize: 22, fontWeight: FontWeight.w700, height: 1.3),
      h2: base.copyWith(fontSize: 19, fontWeight: FontWeight.w700, height: 1.3),
      h3: base.copyWith(fontSize: 17, fontWeight: FontWeight.w600, height: 1.3),
      h4: base.copyWith(fontSize: 15, fontWeight: FontWeight.w600),
      h5: base.copyWith(fontSize: 14, fontWeight: FontWeight.w600),
      h6: base.copyWith(
        fontSize: 13,
        fontWeight: FontWeight.w600,
        color: AppColors.textFaint,
      ),
      blockquote: base.copyWith(color: AppColors.textFaint),
      blockquotePadding: const EdgeInsets.fromLTRB(12, 4, 8, 4),
      blockquoteDecoration: BoxDecoration(
        border: Border(left: BorderSide(color: AppColors.codeBorder, width: 3)),
      ),
      listBullet: base,
      horizontalRuleDecoration: BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.codeBorder)),
      ),
      tableHead: base.copyWith(fontWeight: FontWeight.w700),
      tableBody: base,
      tableBorder: TableBorder.all(color: AppColors.codeBorder),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      blockSpacing: 8,
    );
  }
}
