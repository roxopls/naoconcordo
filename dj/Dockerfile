# `slim` e não `alpine`: o SDK do LiveKit distribui binário compilado contra a
# glibc, e na musl do alpine ele nem carrega.
FROM python:3.12-slim

# O ffmpeg é metade do trabalho: ele lê o endereço que o yt-dlp resolveu e
# devolve PCM cru. `ca-certificates` porque tudo o que ele abre é https.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .

# Sem buffer: o log do container aparece na hora, e não em blocos quando o
# processo resolve descarregar.
ENV PYTHONUNBUFFERED=1
CMD ["python", "bot.py"]
