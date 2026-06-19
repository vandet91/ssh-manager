FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
RUN mkdir -p /var/lib/ssh-manager/recordings
# Impacket (PsExec + WMIExec), pywinrm (WinRM exec), evil-winrm (WinRM interactive shell)
RUN apk add --no-cache python3 py3-pip ruby ruby-dev build-base libffi-dev && \
    pip3 install --break-system-packages impacket pywinrm requests-ntlm 2>/dev/null || \
    pip3 install impacket pywinrm requests-ntlm && \
    gem install evil-winrm --no-document
EXPOSE 3001
CMD ["node", "dist/index.js"]
