FROM python:3.12-alpine
RUN pip install --no-cache-dir tftpy
WORKDIR /app
COPY tftp_server.py .
ENV TFTP_ROOT=/tftp-root
EXPOSE 69/udp
CMD ["python", "tftp_server.py"]
