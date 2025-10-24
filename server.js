const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const crypto = require('crypto');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 8080;

// Environment variables
const DOCKERHUB_SECRET = process.env.DOCKERHUB_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Service mappings
const SERVICE_MAPPINGS = {
  // Backend services
  'auth-service': { namespace: 'backend', deployment: 'auth-service' },
  'masters-service': { namespace: 'backend', deployment: 'masters-service' },
  'orders-service': { namespace: 'backend', deployment: 'orders-service' },
  'users-service': { namespace: 'backend', deployment: 'users-service' },
  'calls-service': { namespace: 'backend', deployment: 'calls-service' },
  'reports-service': { namespace: 'backend', deployment: 'reports-service' },
  'avito-service': { namespace: 'backend', deployment: 'avito-service' },
  'cash-service': { namespace: 'backend', deployment: 'cash-service' },
  'files-service': { namespace: 'backend', deployment: 'files-service' },
  
  // Frontend services
  'callcentre-frontend': { namespace: 'frontend', deployment: 'callcentre-frontend' },
  'dircrm-frontend': { namespace: 'frontend', deployment: 'dircrm-frontend' },
  'mastercrm-frontend': { namespace: 'frontend', deployment: 'mastercrm-frontend' },
  
  // CRM services (3rd node)
  'notifications-service': { namespace: 'crm', deployment: 'notifications-service' },
  'realtime-service': { namespace: 'crm', deployment: 'realtime-service' }
};

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Docker Hub webhook
app.post('/webhook/dockerhub', (req, res) => {
  try {
    // Docker Hub doesn't send signature, so we skip verification
    console.log('📦 Docker Hub webhook received');

    const { repository, push_data } = req.body;
    const imageName = repository.repo_name;
    const tag = push_data.tag;

    console.log(`📦 Docker Hub webhook received for ${imageName}:${tag}`);

    // Find matching service
    const serviceKey = Object.keys(SERVICE_MAPPINGS).find(key => 
      imageName.includes(key)
    );

    if (!serviceKey) {
      console.log(`❌ No service mapping found for ${imageName}`);
      return res.status(200).json({ message: 'No service mapping found' });
    }

    const serviceConfig = SERVICE_MAPPINGS[serviceKey];
    
    // Update deployment
    updateDeployment(serviceConfig.namespace, serviceConfig.deployment, imageName, tag)
      .then(() => {
        console.log(`✅ Successfully updated ${serviceConfig.deployment}`);
        sendTelegramNotification(`🚀 ${serviceConfig.deployment} обновлен до ${imageName}:${tag}`);
      })
      .catch(error => {
        console.error(`❌ Failed to update ${serviceConfig.deployment}:`, error);
        sendTelegramNotification(`❌ Ошибка обновления ${serviceConfig.deployment}: ${error.message}`);
      });

    res.status(200).json({ message: 'Webhook processed successfully' });

  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update deployment function
async function updateDeployment(namespace, deployment, image, tag) {
  return new Promise((resolve, reject) => {
    const fullImageName = `${image}:${tag}`;
    const command = `kubectl set image deployment/${deployment} ${deployment}=${fullImageName} -n ${namespace}`;
    
    console.log(`🔄 Executing: ${command}`);
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ kubectl error: ${error}`);
        reject(error);
        return;
      }
      
      console.log(`✅ kubectl output: ${stdout}`);
      if (stderr) {
        console.log(`⚠️ kubectl stderr: ${stderr}`);
      }
      
      resolve(stdout);
    });
  });
}

// Send Telegram notification
async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram credentials not configured');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const data = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    };

    await axios.post(url, data);
    console.log('📱 Telegram notification sent');
  } catch (error) {
    console.error('❌ Failed to send Telegram notification:', error.message);
  }
}

// Monitor deployments status (runs every 30 seconds)
cron.schedule('*/30 * * * * *', async () => {
  console.log('🔍 Checking deployments status...');
  
  for (const [serviceName, config] of Object.entries(SERVICE_MAPPINGS)) {
    try {
      const status = await getDeploymentStatus(config.namespace, config.deployment);
      
      // Check if service is running (1/1 or more)
      if (status.isReady && status.readyReplicas > 0) {
        console.log(`✅ ${serviceName}: ${status.readyReplicas}/${status.replicas} running`);
      } else {
        console.log(`⚠️ ${serviceName}: ${status.readyReplicas}/${status.replicas} running`);
        
        // Send alert if service is not ready
        if (status.readyReplicas === 0 && status.replicas > 0) {
          await sendTelegramNotification(
            `🚨 <b>${serviceName}</b> не работает!\n` +
            `Статус: ${status.readyReplicas}/${status.replicas}\n` +
            `Namespace: ${config.namespace}`
          );
        }
      }
    } catch (error) {
      console.error(`❌ Error checking ${serviceName}:`, error.message);
    }
  }
});

// Get deployment status
async function getDeploymentStatus(namespace, deployment) {
  return new Promise((resolve, reject) => {
    const command = `kubectl get deployment ${deployment} -n ${namespace} -o json`;
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      
      try {
        const deploymentInfo = JSON.parse(stdout);
        const status = deploymentInfo.status;
        
        resolve({
          name: deployment,
          namespace: namespace,
          replicas: status.replicas || 0,
          readyReplicas: status.readyReplicas || 0,
          availableReplicas: status.availableReplicas || 0,
          updatedReplicas: status.updatedReplicas || 0,
          conditions: status.conditions || [],
          isReady: (status.readyReplicas || 0) === (status.replicas || 0) && (status.replicas || 0) > 0
        });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Webhook Server running on port ${PORT}`);
  console.log(`📡 Docker Hub webhook endpoint: /webhook/dockerhub`);
  console.log(`📊 Status endpoint: /health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully');
  process.exit(0);
});
