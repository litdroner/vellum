// The fonts bundled with Vellum for new text (objects/font-set.js), as static data: each family's id, its
// name as the font selector shows it, the group the selector lists it in, and the file of each face it has
// in web/fonts/document. Every family is licensed under the SIL Open Font License 1.1, whose text is the
// OFL.txt in its folder (web/fonts/document/NOTICE.txt lists them with their copyright and project); a font
// is listed here only with its licence beside it, and only when that licence allows bundling it, using it
// in the app and embedding it in PDFs. The files are unchanged and keep their own names.
//
// `preview`, where a family has it, is the style of its own face the selector shows its name in, for a family
// whose regular face reads much lighter than its neighbours' at the menu's size. Only the menu uses it.
//
// Groups, in the selector's order: sans, serif, mono, legible (fonts designed for low-vision readers),
// international (wide script coverage).

export const BUNDLED_FONTS = Object.freeze([
  { id: 'inter', name: 'Inter', group: 'sans', faces: { regular: 'inter/Inter-Regular.ttf', bold: 'inter/Inter-Bold.ttf', italic: 'inter/Inter-Italic.ttf', 'bold-italic': 'inter/Inter-BoldItalic.ttf' } },
  { id: 'plusjakartasans', name: 'Plus Jakarta Sans', group: 'sans', faces: { regular: 'plusjakartasans/PlusJakartaSans-Regular.ttf', bold: 'plusjakartasans/PlusJakartaSans-Bold.ttf', italic: 'plusjakartasans/PlusJakartaSans-Italic.ttf', 'bold-italic': 'plusjakartasans/PlusJakartaSans-BoldItalic.ttf' } },
  { id: 'dmsans', name: 'DM Sans', group: 'sans', faces: { regular: 'dmsans/DMSans-Regular.ttf', bold: 'dmsans/DMSans-Bold.ttf', italic: 'dmsans/DMSans-Italic.ttf', 'bold-italic': 'dmsans/DMSans-BoldItalic.ttf' } },
  { id: 'figtree', name: 'Figtree', group: 'sans', faces: { regular: 'figtree/Figtree-Regular.ttf', bold: 'figtree/Figtree-Bold.ttf', italic: 'figtree/Figtree-Italic.ttf', 'bold-italic': 'figtree/Figtree-BoldItalic.ttf' } },
  { id: 'urbanist', name: 'Urbanist', group: 'sans', faces: { regular: 'urbanist/Urbanist-Regular.ttf', bold: 'urbanist/Urbanist-Bold.ttf', italic: 'urbanist/Urbanist-Italic.ttf', 'bold-italic': 'urbanist/Urbanist-BoldItalic.ttf' } },
  { id: 'montserrat', name: 'Montserrat', group: 'sans', faces: { regular: 'montserrat/Montserrat-Regular.ttf', bold: 'montserrat/Montserrat-Bold.ttf', italic: 'montserrat/Montserrat-Italic.ttf', 'bold-italic': 'montserrat/Montserrat-BoldItalic.ttf' } },
  { id: 'poppins', name: 'Poppins', group: 'sans', faces: { regular: 'poppins/Poppins-Regular.ttf', bold: 'poppins/Poppins-Bold.ttf', italic: 'poppins/Poppins-Italic.ttf', 'bold-italic': 'poppins/Poppins-BoldItalic.ttf' } },
  { id: 'rubik', name: 'Rubik', group: 'sans', faces: { regular: 'rubik/Rubik-Regular.ttf', bold: 'rubik/Rubik-Bold.ttf', italic: 'rubik/Rubik-Italic.ttf', 'bold-italic': 'rubik/Rubik-BoldItalic.ttf' } },
  { id: 'nunitosans', name: 'Nunito Sans', group: 'sans', faces: { regular: 'nunitosans/NunitoSans-Regular.ttf', bold: 'nunitosans/NunitoSans-Bold.ttf', italic: 'nunitosans/NunitoSans-Italic.ttf', 'bold-italic': 'nunitosans/NunitoSans-BoldItalic.ttf' } },
  { id: 'worksans', name: 'Work Sans', group: 'sans', faces: { regular: 'worksans/WorkSans-Regular.ttf', bold: 'worksans/WorkSans-Bold.ttf', italic: 'worksans/WorkSans-Italic.ttf', 'bold-italic': 'worksans/WorkSans-BoldItalic.ttf' } },
  { id: 'publicsans', name: 'Public Sans', group: 'sans', faces: { regular: 'publicsans/PublicSans-Regular.ttf', bold: 'publicsans/PublicSans-Bold.ttf', italic: 'publicsans/PublicSans-Italic.ttf', 'bold-italic': 'publicsans/PublicSans-BoldItalic.ttf' } },
  { id: 'ibmplexsans', name: 'IBM Plex Sans', group: 'sans', faces: { regular: 'ibmplexsans/IBMPlexSans-Regular.ttf', bold: 'ibmplexsans/IBMPlexSans-Bold.ttf', italic: 'ibmplexsans/IBMPlexSans-Italic.ttf', 'bold-italic': 'ibmplexsans/IBMPlexSans-BoldItalic.ttf' } },
  { id: 'sourcesans3', name: 'Source Sans 3', group: 'sans', faces: { regular: 'sourcesans3/SourceSans3-Regular.ttf', bold: 'sourcesans3/SourceSans3-Bold.ttf', italic: 'sourcesans3/SourceSans3-Italic.ttf', 'bold-italic': 'sourcesans3/SourceSans3-BoldItalic.ttf' } },
  { id: 'firasans', name: 'Fira Sans', group: 'sans', faces: { regular: 'firasans/FiraSans-Regular.ttf', bold: 'firasans/FiraSans-Bold.ttf', italic: 'firasans/FiraSans-Italic.ttf', 'bold-italic': 'firasans/FiraSans-BoldItalic.ttf' } },
  { id: 'barlow', name: 'Barlow', group: 'sans', faces: { regular: 'barlow/Barlow-Regular.ttf', bold: 'barlow/Barlow-Bold.ttf', italic: 'barlow/Barlow-Italic.ttf', 'bold-italic': 'barlow/Barlow-BoldItalic.ttf' } },
  { id: 'liusan', name: 'Liu San', group: 'sans', preview: 'bold', faces: { regular: 'liusan/LiuSan-Regular.ttf', bold: 'liusan/LiuSan-Bold.ttf', italic: 'liusan/LiuSan-Italic.ttf', 'bold-italic': 'liusan/LiuSan-BoldItalic.ttf' } },

  { id: 'sourceserif4', name: 'Source Serif 4', group: 'serif', faces: { regular: 'sourceserif4/SourceSerif4-Regular.ttf', bold: 'sourceserif4/SourceSerif4-Bold.ttf', italic: 'sourceserif4/SourceSerif4-Italic.ttf', 'bold-italic': 'sourceserif4/SourceSerif4-BoldItalic.ttf' } },
  { id: 'ibmplexserif', name: 'IBM Plex Serif', group: 'serif', faces: { regular: 'ibmplexserif/IBMPlexSerif-Regular.ttf', bold: 'ibmplexserif/IBMPlexSerif-Bold.ttf', italic: 'ibmplexserif/IBMPlexSerif-Italic.ttf', 'bold-italic': 'ibmplexserif/IBMPlexSerif-BoldItalic.ttf' } },
  { id: 'librebaskerville', name: 'Libre Baskerville', group: 'serif', faces: { regular: 'librebaskerville/LibreBaskerville-Regular.ttf', bold: 'librebaskerville/LibreBaskerville-Bold.ttf', italic: 'librebaskerville/LibreBaskerville-Italic.ttf', 'bold-italic': 'librebaskerville/LibreBaskerville-BoldItalic.ttf' } },
  { id: 'merriweather', name: 'Merriweather', group: 'serif', faces: { regular: 'merriweather/Merriweather-Regular.ttf', bold: 'merriweather/Merriweather-Bold.ttf', italic: 'merriweather/Merriweather-Italic.ttf', 'bold-italic': 'merriweather/Merriweather-BoldItalic.ttf' } },
  { id: 'lora', name: 'Lora', group: 'serif', faces: { regular: 'lora/Lora-Regular.ttf', bold: 'lora/Lora-Bold.ttf', italic: 'lora/Lora-Italic.ttf', 'bold-italic': 'lora/Lora-BoldItalic.ttf' } },
  { id: 'literata', name: 'Literata', group: 'serif', faces: { regular: 'literata/Literata-Regular.ttf', bold: 'literata/Literata-Bold.ttf', italic: 'literata/Literata-Italic.ttf', 'bold-italic': 'literata/Literata-BoldItalic.ttf' } },
  { id: 'newsreader', name: 'Newsreader', group: 'serif', faces: { regular: 'newsreader/Newsreader-Regular.ttf', bold: 'newsreader/Newsreader-Bold.ttf', italic: 'newsreader/Newsreader-Italic.ttf', 'bold-italic': 'newsreader/Newsreader-BoldItalic.ttf' } },
  { id: 'cormorantgaramond', name: 'Cormorant Garamond', group: 'serif', faces: { regular: 'cormorantgaramond/CormorantGaramond-Regular.ttf', bold: 'cormorantgaramond/CormorantGaramond-Bold.ttf', italic: 'cormorantgaramond/CormorantGaramond-Italic.ttf', 'bold-italic': 'cormorantgaramond/CormorantGaramond-BoldItalic.ttf' } },
  { id: 'crimsonpro', name: 'Crimson Pro', group: 'serif', faces: { regular: 'crimsonpro/CrimsonPro-Regular.ttf', bold: 'crimsonpro/CrimsonPro-Bold.ttf', italic: 'crimsonpro/CrimsonPro-Italic.ttf', 'bold-italic': 'crimsonpro/CrimsonPro-BoldItalic.ttf' } },
  { id: 'dmserifdisplay', name: 'DM Serif Display', group: 'serif', faces: { regular: 'dmserifdisplay/DMSerifDisplay-Regular.ttf', italic: 'dmserifdisplay/DMSerifDisplay-Italic.ttf' } },
  { id: 'playfairdisplay', name: 'Playfair Display', group: 'serif', faces: { regular: 'playfairdisplay/PlayfairDisplay-Regular.ttf', bold: 'playfairdisplay/PlayfairDisplay-Bold.ttf', italic: 'playfairdisplay/PlayfairDisplay-Italic.ttf', 'bold-italic': 'playfairdisplay/PlayfairDisplay-BoldItalic.ttf' } },
  { id: 'bitter', name: 'Bitter', group: 'serif', faces: { regular: 'bitter/Bitter-Regular.ttf', bold: 'bitter/Bitter-Bold.ttf', italic: 'bitter/Bitter-Italic.ttf', 'bold-italic': 'bitter/Bitter-BoldItalic.ttf' } },

  { id: 'jetbrainsmono', name: 'JetBrains Mono', group: 'mono', faces: { regular: 'jetbrainsmono/JetBrainsMono-Regular.ttf', bold: 'jetbrainsmono/JetBrainsMono-Bold.ttf', italic: 'jetbrainsmono/JetBrainsMono-Italic.ttf', 'bold-italic': 'jetbrainsmono/JetBrainsMono-BoldItalic.ttf' } },
  { id: 'firacode', name: 'Fira Code', group: 'mono', faces: { regular: 'firacode/FiraCode-Regular.ttf', bold: 'firacode/FiraCode-Bold.ttf' } },
  { id: 'ibmplexmono', name: 'IBM Plex Mono', group: 'mono', faces: { regular: 'ibmplexmono/IBMPlexMono-Regular.ttf', bold: 'ibmplexmono/IBMPlexMono-Bold.ttf', italic: 'ibmplexmono/IBMPlexMono-Italic.ttf', 'bold-italic': 'ibmplexmono/IBMPlexMono-BoldItalic.ttf' } },
  { id: 'sourcecodepro', name: 'Source Code Pro', group: 'mono', faces: { regular: 'sourcecodepro/SourceCodePro-Regular.ttf', bold: 'sourcecodepro/SourceCodePro-Bold.ttf', italic: 'sourcecodepro/SourceCodePro-Italic.ttf', 'bold-italic': 'sourcecodepro/SourceCodePro-BoldItalic.ttf' } },
  { id: 'spacemono', name: 'Space Mono', group: 'mono', faces: { regular: 'spacemono/SpaceMono-Regular.ttf', bold: 'spacemono/SpaceMono-Bold.ttf', italic: 'spacemono/SpaceMono-Italic.ttf', 'bold-italic': 'spacemono/SpaceMono-BoldItalic.ttf' } },

  { id: 'atkinsonhyperlegible', name: 'Atkinson Hyperlegible', group: 'legible', faces: { regular: 'atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf', bold: 'atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf', italic: 'atkinsonhyperlegible/AtkinsonHyperlegible-Italic.ttf', 'bold-italic': 'atkinsonhyperlegible/AtkinsonHyperlegible-BoldItalic.ttf' } },
  { id: 'atkinsonhyperlegiblenext', name: 'Atkinson Hyperlegible Next', group: 'legible', faces: { regular: 'atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext-Regular.ttf', bold: 'atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext-Bold.ttf', italic: 'atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext-Italic.ttf', 'bold-italic': 'atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext-BoldItalic.ttf' } },
  { id: 'atkinsonhyperlegiblemono', name: 'Atkinson Hyperlegible Mono', group: 'legible', faces: { regular: 'atkinsonhyperlegiblemono/AtkinsonHyperlegibleMono-Regular.ttf', bold: 'atkinsonhyperlegiblemono/AtkinsonHyperlegibleMono-Bold.ttf', italic: 'atkinsonhyperlegiblemono/AtkinsonHyperlegibleMono-Italic.ttf', 'bold-italic': 'atkinsonhyperlegiblemono/AtkinsonHyperlegibleMono-BoldItalic.ttf' } },

  { id: 'notosans', name: 'Noto Sans', group: 'international', faces: { regular: 'notosans/NotoSans-Regular.ttf', bold: 'notosans/NotoSans-Bold.ttf', italic: 'notosans/NotoSans-Italic.ttf', 'bold-italic': 'notosans/NotoSans-BoldItalic.ttf' } },
  { id: 'notoserif', name: 'Noto Serif', group: 'international', faces: { regular: 'notoserif/NotoSerif-Regular.ttf', bold: 'notoserif/NotoSerif-Bold.ttf', italic: 'notoserif/NotoSerif-Italic.ttf', 'bold-italic': 'notoserif/NotoSerif-BoldItalic.ttf' } },
]);
