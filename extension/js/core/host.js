/**
 * host.js — ponte com o host.jsx (ExtendScript dentro do Premiere).
 *   const data = await AEHost.call("info");
 * Rejeita a Promise com a mensagem de erro vinda do Premiere.
 */
(function (root) {
  const cs = new CSInterface();

  function escapeForExtendScript(s) {
    // U+2028/U+2029 quebram literais de string no ExtendScript
    const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    return s.split(LS).join("\\u2028").split(PS).join("\\u2029");
  }

  function call(name, args) {
    const payload = escapeForExtendScript(JSON.stringify(JSON.stringify(args || {})));
    const script = `typeof AutomacaoEdicao === "undefined" ? "__NOHOST__" : AutomacaoEdicao.call(${JSON.stringify(name)}, ${payload})`;
    return new Promise((resolve, reject) => {
      if (!cs.isInHost()) {
        reject(new Error("Este painel só funciona dentro do Premiere Pro."));
        return;
      }
      cs.evalScript(script, (raw) => {
        if (raw === "__NOHOST__") {
          reject(new Error("O script do Premiere (host.jsx) não carregou. Feche e abra o painel."));
          return;
        }
        let res;
        try {
          res = JSON.parse(raw);
        } catch (e) {
          reject(new Error(raw === "EvalScript error." ? "Erro de script no Premiere." : `Resposta inesperada do Premiere: ${String(raw).slice(0, 200)}`));
          return;
        }
        if (res.ok) resolve(res.data);
        else reject(new Error(res.error || "Erro desconhecido no Premiere."));
      });
    });
  }

  root.AEHost = { call, cs };
})(window);
