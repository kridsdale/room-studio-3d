import { rollup } from 'rollup';
import resolve from '@rollup/plugin-node-resolve';
import { minify } from 'terser';
import fs from 'node:fs';
import path from 'node:path';

async function build() {
  console.log('Bundling Three.js + Room Studio modules with Rollup...');
  const bundle = await rollup({
    input: path.resolve('src/main.js'),
    plugins: [resolve({ browser: true })],
  });

  const { output } = await bundle.generate({
    format: 'iife',
    name: 'RoomStudioApp',
  });
  await bundle.close();

  const rawJs = output[0].code;
  console.log(`Raw JS bundle: ${(rawJs.length / 1024).toFixed(1)} KB. Minifying with Terser...`);
  const minified = await minify(rawJs, {
    compress: { passes: 2 },
    mangle: true,
  });
  const minJs = minified.code;
  console.log(`Minified JS bundle: ${(minJs.length / 1024).toFixed(1)} KB.`);

  const css = fs.readFileSync(path.resolve('src/styles.css'), 'utf8');
  const html = fs.readFileSync(path.resolve('src/index.html'), 'utf8');

  // Escape any </script> sequence inside JS safely
  const safeJs = minJs.replace(/<\/script/gi, '<\\/script');
  const finalHtml = html
    .replace('/*__INLINE_CSS__*/', () => css)
    .replace('/*__INLINE_JS__*/', () => safeJs);

  fs.mkdirSync(path.resolve('dist'), { recursive: true });
  const outPath = path.resolve('dist/index.html');
  fs.writeFileSync(outPath, finalHtml, 'utf8');
  for (const staticPage of ['privacy.html', 'terms.html', 'google40f71daa35aab7eb.html']) {
    const srcPage = path.resolve('src', staticPage);
    if (fs.existsSync(srcPage)) {
      fs.copyFileSync(srcPage, path.resolve('dist', staticPage));
    }
  }
  console.log(`Built standalone app: ${outPath} (${(finalHtml.length / 1024).toFixed(1)} KB) + static pages`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
