// Part of `npm run build`: the Ogg Vorbis encoder (compiler/vorbis.ts) as dist/vorbis.wasm, beside the compiler that
// fetches it, with its licences — wasm-media-encoders' (MIT) and libvorbis's and libogg's (BSD), which it is built from.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkg = resolve(import.meta.dirname, "..", "node_modules", "wasm-media-encoders");
const { version } = JSON.parse(readFileSync(resolve(pkg, "package.json"), "utf8"));
copyFileSync(resolve(pkg, "wasm", "ogg.wasm"), resolve(import.meta.dirname, "..", "dist", "vorbis.wasm"));
writeFileSync(resolve(import.meta.dirname, "..", "dist", "vorbis.wasm.LEGAL.txt"), `dist/vorbis.wasm is wasm-media-encoders ${version}'s wasm/ogg.wasm: libvorbis and libogg compiled to WebAssembly.

wasm-media-encoders — https://github.com/arseneyr/wasm-media-encoders
${readFileSync(resolve(pkg, "LICENSE"), "utf8").trim()}

libvorbis and libogg — https://xiph.org/
libvorbis: Copyright (c) 2002-2020 Xiph.org Foundation
libogg: Copyright (c) 2002, Xiph.org Foundation

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

- Redistributions of source code must retain the above copyright notice, this list of conditions and the following
  disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
  disclaimer in the documentation and/or other materials provided with the distribution.
- Neither the name of the Xiph.org Foundation nor the names of its contributors may be used to endorse or promote
  products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \`\`AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE FOUNDATION OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF
USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`);
