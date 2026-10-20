Primeira versão publicada com o código completo (a anterior no GitHub era a 2.4.2).

**Aba Sincronizar — sincronização por imagem** (para câmeras sem áudio útil):
- **Boca × voz:** compara a abertura da boca de cada pessoa com o áudio dos gravadores. Trechos fracos que concordam no mesmo quadro passam a contar (consenso); a análise normal olha um 2º trecho quando o 1º não basta.
- **Claquete:** detecta a batida na imagem e casa com o estalo do gravador; com várias tomadas, casa câmera e tomada pela ordem e duração.
- **Claquete reconhecida (2.9):** para câmeras em movimento (gimbal), reconhece a claquete da produtora por uma imagem de referência e mede o fechamento da ripa (o espelho das listras), mesmo com a claquete inclinada. Resultado em "Pêssego" (revisar).
- **2.9.1:** reconhecimento da claquete ~2–3× mais rápido, mesmo resultado.

Gravador contínuo (palestra, podcast) segue o caminho da boca sem regras de tomada.

Observação: fontes Altivo e a referência da claquete não estão no repositório (ver README).
