// Prova o painel de convites: so o admin emite, cada codigo serve uma conta
// e o servidor registra quem usou.
import crypto from "node:crypto";
import { env, post, get, check, report, readData, admin, register, createUser, mintInvite } from "./test-common.mjs";

const dono = await admin();
const comum = await createUser("conv-comum");
const nome = label => label + "-" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex");

check("adminVeConvites", (await get("/api/admin/invites", dono.token)).status === 200);
check("comumNaoVeConvites", (await get("/api/admin/invites", comum.token)).status === 403);
check("comumNaoCriaConvite", (await post("/api/admin/invites", { label: "x" }, comum.token)).status === 403);
check("semSessaoNaoVeConvites", (await get("/api/admin/invites")).status === 401);

const convite = await mintInvite("familia");
check("conviteTemCodigo", typeof convite.code === "string" && convite.code.length >= 12);
check("conviteNasceLivre", convite.usedBy === null && convite.revoked === false);
check("conviteGuardaRotulo", convite.label === "familia");

const usuario = nome("conv-usa");
check("cadastroComConvite", (await register(usuario, convite.code)).ok);
const lista = await (await get("/api/admin/invites", dono.token)).json();
const usado = lista.invites.find(item => item.code === convite.code);
check("painelMostraQuemUsou", usado?.usedBy === usuario && Boolean(usado.usedAt));

check("conviteNaoServeDuasVezes", (await register(nome("conv-repete"), convite.code)).status === 401);
check("chaveGlobalNaoCadastra", (await register(nome("conv-global"), null)).status === 401);
check("codigoInventadoNaoCadastra", (await register(nome("conv-falso"), "codigo-inventado-123")).status === 401);

const revogar = await mintInvite("revogado");
check("adminRevoga", (await post("/api/admin/invites/revoke", { code: revogar.code }, dono.token)).status === 204);
check("conviteRevogadoNaoCadastra", (await register(nome("conv-revog"), revogar.code)).status === 401);
check("revogarUsadoRetornaConflito", (await post("/api/admin/invites/revoke", { code: convite.code }, dono.token)).status === 409);
check("revogarInexistente404", (await post("/api/admin/invites/revoke", { code: "nao-existe" }, dono.token)).status === 404);
check("comumNaoRevoga", (await post("/api/admin/invites/revoke", { code: revogar.code }, comum.token)).status === 403);

const bootAdmin = await (await get("/api/bootstrap", dono.token)).json();
const bootComum = await (await get("/api/bootstrap", comum.token)).json();
check("bootstrapMarcaAdmin", bootAdmin.isAdmin === true);
check("bootstrapNegaAdminParaComum", bootComum.isAdmin === false);

const disco = readData("invites.json");
if (disco) {
  check("convitePersistido", disco.some(item => item.code === convite.code && item.usedBy === usuario));
  check("codigoNaoGuardaSenhaGlobal", !disco.some(item => item.code === env.ACCESS_PASSWORD));
}

report();
