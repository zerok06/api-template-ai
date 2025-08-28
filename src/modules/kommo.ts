import { config } from "../config";



const SUBDOMAIN = config.kommo.subdomain;
const TOKEN = config.kommo.api_secret;
const API_URI = `https://${SUBDOMAIN}.kommo.com/api`



enum Params {
    contacts = "contacts",
    only_deleted = "only_deleted",
    loss_reason = "loss_reason",
    is_price_modified_by_robot = "is_price_modified_by_robot",
    catalog_elements = "catalog_elements",
    source_id = "source_id",
    source = "source"
}

const findLead = async (id: number, params?: Params): Promise<Lead | null> => {
    const url = `${API_URI}/v4/leads/${id}${params ? `?with=${params}` : ''}`;
    const options = { method: 'GET', headers: { accept: 'application/json', "Authorization": `Bearer ${TOKEN}` } }
    const response = await fetch(url, options)
    const data = await response.json();

    return data;
}

interface Lead {
    id?: number
    name?: string
    price?: string
    status_id?: number
    pipeline_id?: number
    responsible_user_id?: number
    custom_fields_values: Array<{ field_id: number; values: Array<{ value: string | number }> }>
}

const updateLead = async (id: number, updates: Partial<Lead>) => {
    const url = `${API_URI}/v4/leads/${id}`;
    const options = {
        method: 'PATCH',
        headers: {
            accept: 'application/json',
            "Authorization": `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(updates)
    };
    const response = await fetch(url, options);
    const data = await response.json();

    return data;
}

const executeBot = async (entity_id: number, entity_type: '1' | '2', bot_id: number) => {
    const url = `${API_URI}/v2/salesbot/run`;
    console.log(url);

    const options = {
        method: 'POST',
        headers: {
            accept: 'application/json',
            "Authorization": `Bearer ${TOKEN}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify([{ bot_id, entity_type, entity_id }])
    };
    console.log('execute bot:', bot_id)
    const request = await fetch(url, options);
    const data = await request.json();
    console.log('bot response:', data)
}


export const kommo = {
    lead: {
        find: findLead,
        update: updateLead,
    },
    bot: {
        execute: executeBot
    }
}