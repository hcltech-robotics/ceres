import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname,"..");
const lock = JSON.parse(readFileSync(path.join(root,"package-lock.json"),"utf8"));
const output = path.join(root,"third-party");
mkdirSync(output,{recursive:true});
const entries=[];
for(const [directory, value] of Object.entries(lock.packages)) {
  if(!directory || !existsSync(path.join(root,directory))) continue;
  const name = value.name ?? directory.split("node_modules/").at(-1);
  const notices = readdirSync(path.join(root,directory)).filter(file=>/^(?:licen[cs]e|copying|notice|copyright)(?:\.|$)/i.test(file));
  for(const file of notices) {
    const location=path.join(root,directory,file);
    try {
      const target=`${name.replaceAll("/","_")}@${value.version}-${file}`;
      writeFileSync(path.join(output,target),readFileSync(location));
      entries.push({name,version:value.version,licence:value.license??null,file:target});
    } catch(error) { if(error.code!=="EISDIR") throw error; }
  }
}
const productionLock = structuredClone(lock);
delete productionLock.packages[""].devDependencies;
for (const [name,value] of Object.entries(productionLock.packages)) if (value.dev) delete productionLock.packages[name];
writeFileSync(path.join(output,"package-lock.json"),JSON.stringify(productionLock,null,2)+"\n");
for (const crate of ["recorder-kernels","lerobot-exporter"]) {
  const directory=path.join(output,crate);
  mkdirSync(directory,{recursive:true});
  writeFileSync(path.join(directory,"Cargo.lock"),readFileSync(path.join(root,"wasm",crate,"Cargo.lock")));
  const metadata=JSON.parse(execFileSync("cargo",["metadata","--locked","--format-version","1","--manifest-path",`wasm/${crate}/Cargo.toml`],{cwd:root,encoding:"utf8",maxBuffer:16*1024*1024,windowsHide:true}));
  for (const component of metadata.packages) {
    if (!component.source) continue;
    const source=path.dirname(component.manifest_path);
    for (const file of readdirSync(source).filter(name=>/^(?:licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(name))) {
      const name=`rust-${component.name}@${component.version}-${file}`;
      try {
        writeFileSync(path.join(output,name),readFileSync(path.join(source,file)));
        if (!entries.some(entry=>entry.file===name)) entries.push({name:component.name,version:component.version,licence:component.license,file:name});
      } catch(error) { if(error.code!=="EISDIR") throw error; }
    }
  }
}
writeFileSync(path.join(output,"components.json"),JSON.stringify(entries,null,2)+"\n");
console.log(`Collected ${entries.length} dependency notices`);
