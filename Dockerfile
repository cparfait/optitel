FROM python:3.12-slim

# Sorties non tamponnées : sans cela les messages de construction du dataset
# n'apparaissent dans `docker logs` qu'une fois le tampon plein.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    OPTITEL_FACTURES_DIR=/data/factures \
    OPTITEL_DATA_DIR=/data/dataset \
    OPTITEL_CACHE_DIR=/data/cache

WORKDIR /app

# Dépendances d'abord : cette couche ne se reconstruit que si requirements.txt
# change, alors que le code change à chaque itération.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY parser_invoice.py auth.py server.py wsgi.py ./
COPY web/ ./web/

# L'application écrit les PDF déposés, le dataset et le cache : elle tourne sans
# privilèges et ne possède que /data.
RUN useradd --create-home --uid 10001 optitel \
    && mkdir -p /data/factures /data/dataset /data/cache \
    && chown -R optitel:optitel /data
USER optitel

VOLUME ["/data"]
EXPOSE 8484

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8484/api/health',timeout=4).status==200 else 1)"

# Un seul worker : le dataset est reconstruit sous un verrou en mémoire de
# processus (`threading.Lock`), qui ne protège rien entre plusieurs workers —
# deux imports simultanés s'écraseraient. Les threads suffisent largement ici,
# la charge étant de quelques utilisateurs internes.
# Le timeout est long car la reconstruction lit 78 PDF.
CMD ["gunicorn", "--bind", "0.0.0.0:8484", \
     "--workers", "1", "--threads", "8", \
     "--timeout", "300", "--graceful-timeout", "30", \
     "--access-logfile", "-", "--error-logfile", "-", \
     "wsgi:app"]
