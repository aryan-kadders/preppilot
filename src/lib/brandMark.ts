// PrepPilot's mark: an "A" (for Aryan) inscribed in a ring, one filled path.
//
// Same geometry as upstream's "N in a ring" so every place that drew the old
// mark keeps its layout: a 1024 box, the ring cropped to 106..918 (812 wide),
// ring and letter strokes ~75 wide. The A is two legs, a crossbar, and a
// triangular counter cut out by winding (nonzero fill). The app icons in
// assets/ are generated from this path (scripts/generate-brand-icons.mjs).

export const BRAND_MARK_VIEWBOX = '106 106 812 812';
export const BRAND_MARK_ORIGIN = 106;
export const BRAND_MARK_BOX = 812;

export const BRAND_MARK_D = [
  // ring
  'M512 106 A406 406 0 1 1 512 918 A406 406 0 1 1 512 106 Z',
  'M512 181 A331 331 0 1 0 512 843 A331 331 0 1 0 512 181 Z',
  // A: legs and crossbar
  'M474 230 H550 L722 794 H643 L602.1 660 H421.9 L381 794 H302 Z',
  // A: the counter above the crossbar
  'M512 364.5 L443.2 590 H580.8 Z',
].join(' ');
