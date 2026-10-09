// The SEO Studio mark: the bare symbol, used on both themes and as the tab
// icon. The rest of the logo system (stacked, horizontal, icon tile) sits
// beside it in public/brand/.

export default function BrandMark({ size = 28, style }) {
  return (
    <span style={{ display: 'inline-flex', flexShrink: 0, ...style }}>
      <img src="/brand/seo-studio-submark.svg" alt="SEO Studio" width={size} height={size} draggable={false} />
    </span>
  );
}
