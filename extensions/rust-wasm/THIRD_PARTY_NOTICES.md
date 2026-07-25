# Third-party notices

## OVITO Basic ray-cylinder implementation

CatGo's analytic WebGL bond cylinder rendering and picking code is adapted from
OVITO Basic commit `0b2cdccef7452bf28212e15daf9df2dc7a545bcc`.

Audited upstream files:

- `src/ovito/opengl/OpenGLCylinderPrimitive.cpp`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder.vert`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder.frag`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder_picking.vert`
- `src/ovito/opengl/resources/glsl/cylinder/cylinder_picking.frag`

Material CatGo changes: WebGL2 GLSL3 syntax, Three.js uniforms, half-bond replica decoding, static atom-color lookup, analytic coverage, sparse ghost halves, and GPU picking.

Copyright 2026 OVITO GmbH, Germany

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
