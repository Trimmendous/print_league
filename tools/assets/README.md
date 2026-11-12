# Trophy artwork

`../../static/assets/benchy-trophy.png` is a transparent CPU Cycles rendering of the trophy body in the user-supplied `Coloured_BenchyTrophyU-MAKING-WAVES-FIXED.3mf`. `trophy.blend` retains the editable rendering scene; `trophy-source.json` records the source filename, hash, and conversion limitations. To reproduce the artwork, set `TROPHY_SOURCE` to your copy of the original model and run Blender:

```sh
blender --background --factory-startup --python tools/render_trophy.py
```

The source identifies the original trophy as 3DDoc and the separate MAKING WAVES / IN 3D label as a local personal modification. No license is specified in the source. The original model is unchanged. Geometry is imported in millimeters; only the camera, materials, and lighting are added. The separate label plate has no assembled placement, so it is not attached speculatively. The support enforcer is excluded. Simple paint assignments use the four source filament regions, with a darker gold presentation material; complex subdivided paint faces use a dominant-color approximation, recorded in the manifest. This is website artwork, not a revised print project or a slicing artifact.

The interface counts one trophy per awarded category in a completed round. Tallies show up to eight individual trophies followed by the remaining count, and always include a text total for accessibility.

## Shared 2D Benchy mark

`static/assets/benchy.svg` is the canonical vector side profile, redrawn from the user's `2d_benchy.webp` reference. Its `#boat` symbol is reused by the header, countdown, print-card placeholders, Benchy rain and 404 page. The cabin arch and bow porthole are transparent cutouts; CSS controls the two-tone green/coral brand palette or single-color variants. Keep geometry in this file rather than maintaining separate inline boat drawings.

## Example model photo

`static/assets/example-benchy-trophy.webp` is the 26 KB MakerWorld-hosted listing photo for [10th Anniversary Benchy Trophy Topology Optimized by Franken 3D](https://makerworld.com/en/models/1312719-10th-anniversary-benchy-trophy-topology-optimized). Original image: https://makerworld.bblmw.com/makerworld/model/USec814bb591d322/design/2025-04-12_089e89655991d8.jpg?x-oss-process=image%2Fresize%2Cw_1000%2Fformat%2Cwebp . It illustrates the local sample link, which retains the source URL. It is distinct from our 3DDoc league trophy rendering.

The current trophy artwork uses a front three-quarter perspective camera at `(220, -220, 170)` with a 72 mm lens. The elevated view reveals the deck and cabin depth. The boat uses darker gold `#B27A20`, metallic 0.62 and roughness 0.28, with a smaller key light and reduced fill to preserve detail. Rendering is 1080 × 1290 at 96 samples. These are presentation changes only; the supplied print geometry is unchanged.
