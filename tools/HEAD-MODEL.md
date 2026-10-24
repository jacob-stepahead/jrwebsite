# Jacob's 3D head: brief for the Blender session

The homepage hero (`index.html`, code in `js/hero/`) is finished and waiting for one file:
`assets/models/jacob-head.glb`. Until it exists the hero shows an empty studio. This brief is for
the Claude session on Jacob's Mac, where the Blender MCP connection and his face photos live.

## The target

The reference is **jribh.com**, Jribh Shandilya's portfolio. He built his head in Fusion 360
(T-spline modeling), cleaned it up and animated the hair in Blender, and exported it as glTF. It is
shown in Three.js with HDRI lighting, bloom on the eyes and a fluted-glass effect. Open jribh.com in a
browser before starting and screenshot its hero. That screenshot is the quality bar.

What to aim for:
- **Recognizably Jacob.** Proportions, nose, jaw, brow and hairline come from his photos.
- **Sculpted, not scanned.** Smooth, clean surfaces like a porcelain bust, with no photo-scan noise or
  blotchy textures. Stylized smoothness is what makes jribh's head read as premium, and it hides the
  flaws of a photo-built mesh.
- **Separate hair** that can move slightly (optional, but it is what makes jribh's version feel alive).
- **Separate eyes** that the site makes glow.

Jacob has tried twice already: his own head and a ChatGPT-assisted one. He didn't love either. Inspect
both in the scene, keep whichever has the better likeness, and refine it. Don't start from scratch
unless both are unusable.

## Done means

Do not call the head finished until all three are true, judged side by side in one image (jribh.com
hero | local site hero with Jacob's head | a photo of Jacob):
1. It looks like Jacob. Ask him to confirm.
2. It is at jribh's quality level: clean silhouette, smooth shading, no faceting, artifacts or holes.
3. It sits in the same style: dark studio, rim light, glowing eyes, fluted glass.

## Blender checklist

1. **Inspect** the scene through the MCP: list the objects, find the head mesh(es), reference images,
   modifiers, triangle counts and materials. Screenshot the viewport.
2. **Refine** the chosen head. Remesh or retopologize if it's noisy, then smooth and sculpt to match
   the photos (use them as front and side reference images). Keep the neck, cut flat below it.
3. **Name the parts exactly.** The site styles meshes by name:
   - `Head`: skin (gets the porcelain material on the site)
   - `Hair` (and `Brows` / `Beard` if separate): darker satin material
   - `Eye_L`, `Eye_R`: spheres with their origins at their centers; these glow
4. **Orientation:** in Blender the face points to **-Y** (Numpad 1 / Front view looks at the face),
   with Z up. Position and scale don't matter; the site centers and scales the model automatically.
5. **Budget:** about 60k triangles for the head and 40k for the hair or less, after applying modifiers.
   Textures, if any: 2048px max, JPEG or WebP.
6. **Hair motion (optional):** a short looping shape-key or armature animation. Every exported
   animation clip plays in a loop on the site.
7. **Export:** File > Export > glTF 2.0
   - Format: glTF Binary (.glb)
   - Include: Selected Objects (head, hair, eyes only; no cameras, lights or reference images)
   - Transform: +Y Up
   - Data > Mesh: Apply Modifiers, Normals on; Compression **off** (gltfpack compresses later)
   - Images: JPEG or WebP if there are textures
   - Save as `assets/models/jacob-head-raw.glb` (gitignored; never commit it)

## Compress, preview, tune

```bash
cd tools
npm install            # once
npm run pack-head      # jacob-head-raw.glb -> jacob-head.glb (meshopt-compressed; target under 2 MB)
cd ..
python3 -m http.server 8123   # then open http://localhost:8123
```

Every look setting is in the `SETTINGS` block at the top of `js/hero/hero.js`: material preset,
head-follow strength, eye glow color and intensity, bloom, fluted-glass rib width and refraction, and
the clear window around the face. After changing it, run `npm run build` in `tools/` to regenerate
`js/hero.min.js`.

- To keep Blender's own materials and textures instead of the porcelain override, set
  `data-material="original"` on the `<canvas class="hero-canvas">` in `index.html`.
- `?model=assets/models/other.glb` on the URL loads a different model, for A/B comparisons.

## Ship

Commit `assets/models/jacob-head.glb` (compressed only), plus any tuning changes and the rebuilt
`js/hero.min.js`. Optional: render a still of the head in Blender to `assets/img/jacob-head.jpg`
(1200×630) and add it as `og:image` in `index.html` for link previews.
