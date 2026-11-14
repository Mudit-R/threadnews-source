// Keep the plain JSON edition and the browser's script fallback in the same shape.
export function serializeEdition(payload){
  const json=JSON.stringify(payload,null,2)+'\n';
  const safe=JSON.stringify(payload).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return{json,js:'// Automatically generated headline/link edition.\nglobalThis.NEWS_SNAPSHOT = '+safe+';\n'};
}
