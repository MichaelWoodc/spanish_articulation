// In the uploadBatchAsync function, replace the table creation part:
async function uploadBatchAsync(batchNumber, blob, words) {
  // ... existing code ...
  
  try {
    const response = await fetch(API_URL, {
      method: "POST", 
      body: formData
    });
    
    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    
    const data = await response.json();
    console.log(`Batch ${batchNumber} upload complete:`, data);
    
    // Extract only what we need from the response
    const transcriptionData = {
      text: data.text || "",
      segments: data.segments || []
    };
    
    // Use the new ScoringTable class
    const batchEntries = document.querySelectorAll('.batch-entry');
    const batchEntry = batchEntries[batchNumber - 1];
    
    if (batchEntry) {
      const scoringTable = new ScoringTable(
        batchEntry,
        currentBatchWords, // The expected words for this batch
        transcriptionData,
        wordData // The full word objects from JSON
      );
      scoringTable.init();
    }
    
    showStatus(`Batch ${batchNumber} transcribed!`);
    
  } catch (error) {
    console.error(`Upload failed for batch ${batchNumber}:`, error);
    showStatus(`Batch ${batchNumber} failed!`);
  }
}